import fs from "node:fs";
import path from "node:path";
import { resolveWorkspaceRoot } from "../upstream/workspace.mjs";
import { PluginError } from "./errors.js";

function validatePath(value: string): void {
  if (typeof value !== "string" || !value.length || /[\x00-\x1f\x7f]/.test(value) ||
      value.split(/[\\/]/).includes("..")) {
    throw new PluginError("PATH_OUTSIDE_WORKSPACE", "Invalid path or parent-directory traversal");
  }
  if (process.platform === "win32") {
    const local = value.replace(/^[a-z]:[\\/]/i, "");
    if (/[:*?"<>|]/.test(local) || /^[\\/]{2}/.test(value) ||
        local.split(/[\\/]/).some(part => part !== "." && /[ .]$/.test(part))) {
      throw new PluginError("PATH_OUTSIDE_WORKSPACE", "Invalid Windows path");
    }
  }
}

export function containsPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

export function samePath(left: string, right: string): boolean {
  return path.relative(left, right) === "";
}

export function canonicalDirectory(value: string): string {
  validatePath(value);
  try {
    const real = fs.realpathSync.native(value);
    if (fs.statSync(real).isDirectory()) return real;
  } catch {
    // Return a bounded error without platform-specific diagnostics.
  }
  throw new PluginError("INVALID_ARGUMENTS", "Working directory must be an existing directory");
}

export function workspaceRoot(value: string): string {
  return canonicalDirectory(resolveWorkspaceRoot(canonicalDirectory(value)));
}

export function pathInWorkspace(root: string, value: string, allowMissing = false): string {
  validatePath(value);
  const absoluteRoot = canonicalDirectory(root);
  const lexicalRoot = path.resolve(root);
  const absolute = path.resolve(root, value);
  if (!containsPath(lexicalRoot, absolute) && !containsPath(absoluteRoot, absolute)) {
    throw new PluginError("PATH_OUTSIDE_WORKSPACE", "Path is outside the workspace");
  }
  let ancestor = absolute;
  const missing: string[] = [];
  for (;;) {
    try {
      fs.lstatSync(ancestor);
      break;
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT" ||
          !containsPath(absoluteRoot, ancestor) && !containsPath(lexicalRoot, ancestor) ||
          path.dirname(ancestor) === ancestor) {
        throw new PluginError("PATH_OUTSIDE_WORKSPACE", "Path does not exist or cannot be accessed");
      }
      missing.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
  let real: string;
  try {
    real = fs.realpathSync.native(ancestor);
  } catch {
    throw new PluginError("SYMLINK_ESCAPE", "Path contains an unresolved symbolic link");
  }
  const target = path.join(real, ...missing);
  if (!containsPath(absoluteRoot, target)) {
    throw new PluginError("SYMLINK_ESCAPE", "Path resolves outside the workspace");
  }
  return target;
}

export function validateGitRef(ref: string): string {
  if (typeof ref !== "string" || !/^[A-Za-z0-9_./][A-Za-z0-9_.\/-]{0,254}$/.test(ref) ||
      ref.startsWith("/") || ref.includes("..") || ref.includes("//") || ref.endsWith("/")) {
    throw new PluginError("INVALID_ARGUMENTS", "Invalid Git reference");
  }
  return ref;
}

export function auditAllowedPaths(root: string, allowedPaths: string[], touchedFiles: string[]): string[] {
  if (!allowedPaths.length) return [];
  const allowed = allowedPaths.map(value => pathInWorkspace(root, value, true));
  return [...new Set(touchedFiles)].filter(file => {
    try {
      return !allowed.some(dir => containsPath(dir, pathInWorkspace(root, file, true)));
    } catch {
      return true;
    }
  });
}

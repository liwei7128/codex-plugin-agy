import fs from "node:fs";
import path from "node:path";
import { getRepoRoot, getWorkingTreeState } from "../upstream/git.mjs";
import { containsPath, pathInWorkspace } from "../security/index.js";

export function snapshotChanges(cwd: string, anchor = cwd): Map<string, string> {
  const files = new Map<string, string>();
  try {
    const root = pathInWorkspace(anchor, getRepoRoot(cwd));
    const changes = getWorkingTreeState(root);
    for (const [kind, names] of Object.entries({ index: changes.staged, worktree: changes.unstaged, untracked: changes.untracked })) {
      for (const name of names.slice(0, 1000)) {
        const file = path.join(root, name);
        if (!containsPath(cwd, file)) continue;
        const key = path.relative(cwd, file);
        let stamp = "missing";
        try {
          const stat = fs.lstatSync(pathInWorkspace(cwd, file, true));
          stamp = stat.size + "/" + stat.mtimeMs;
        } catch {
          // A Git removal or an escaping link still belongs in the reported scope.
        }
        files.set(key, (files.get(key) ?? "") + "/" + kind + "/" + stamp);
      }
    }
  } catch {
    // File-change notifications remain the available audit evidence in non-Git scopes.
  }
  return files;
}

export function changedSince(cwd: string, before: Map<string, string>, anchor = cwd) {
  const after = snapshotChanges(cwd, anchor);
  return [...new Set([...before.keys(), ...after.keys()])].filter(file => before.get(file) !== after.get(file));
}

export function detectConflicts(files: Iterable<string>, others: Iterable<Iterable<string>>) {
  const key = (file: string) => process.platform === "win32" ? file.replaceAll("\\", "/").toLowerCase() : file;
  const otherFiles = new Set([...others].flatMap(group => [...group].map(key)));
  return [...new Set([...files].filter(file => otherFiles.has(key(file))))].sort();
}

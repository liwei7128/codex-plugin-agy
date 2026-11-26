import fs from "node:fs";
import path from "node:path";
import { readJsonFile, withFileLock, writeJsonFile } from "../upstream/fs.mjs";
import { canonicalDirectory, pathInWorkspace, PluginError, samePath, SecretRedactor } from "../security/index.js";
import type { RuntimeThread } from "../runtime/index.js";

export interface ThreadBinding extends RuntimeThread {
  createdAt: string;
  lastJobId: string;
  worktreePath: string | null;
}

const redact = new SecretRedactor();
const validId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function resumeCommand(threadId: string | null, ephemeral = false): string | null {
  return threadId && !ephemeral && validId.test(threadId) ? "codex resume " + threadId : null;
}

export class SessionManager {
  constructor(readonly workspaceRoot: string, readonly directory: string) {}

  private read(): Record<string, ThreadBinding> {
    try {
      const file = path.join(this.directory, "sessions.json");
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error("Invalid session index file");
      return readJsonFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  require(threadId: string, cwd?: string): ThreadBinding {
    if (!validId.test(threadId)) throw new PluginError("THREAD_NOT_FOUND", "Invalid Codex thread ID");
    const bindings = this.read();
    const binding = Object.hasOwn(bindings, threadId) ? bindings[threadId] : undefined;
    if (!binding) throw new PluginError("THREAD_WORKSPACE_MISMATCH", "No binding for the thread in this workspace");
    if (binding.ephemeral) throw new PluginError("THREAD_NOT_FOUND", "Ephemeral review threads cannot be resumed");
    if (!samePath(canonicalDirectory(this.workspaceRoot), canonicalDirectory(binding.workspaceRoot)) ||
        cwd && !samePath(canonicalDirectory(cwd), canonicalDirectory(binding.cwd))) {
      throw new PluginError("THREAD_WORKSPACE_MISMATCH", "Thread is bound to a different workspace or working directory");
    }
    const anchor = binding.worktreePath ?? this.workspaceRoot;
    pathInWorkspace(anchor, binding.cwd);
    return binding;
  }

  bind(thread: RuntimeThread, lastJobId: string, worktreePath: string | null = null): void {
    if (!validId.test(thread.threadId) || !samePath(this.workspaceRoot, thread.workspaceRoot)) {
      throw new PluginError("THREAD_WORKSPACE_MISMATCH", "Thread cannot be bound to this workspace");
    }
    pathInWorkspace(worktreePath ?? this.workspaceRoot, thread.cwd);
    fs.mkdirSync(this.directory, { mode: 0o700, recursive: true });
    withFileLock(path.join(this.directory, ".sessions.lock"), () => {
      const bindings = this.read();
      const existing = Object.hasOwn(bindings, thread.threadId) ? bindings[thread.threadId] : undefined;
      if (existing && (!samePath(existing.cwd, thread.cwd) || existing.ephemeral !== thread.ephemeral)) {
        throw new PluginError("THREAD_WORKSPACE_MISMATCH", "Thread binding cannot be moved or changed");
      }
      const binding = { ...thread, lastJobId, worktreePath, createdAt: existing?.createdAt ?? new Date().toISOString() };
      writeJsonFile(path.join(this.directory, "sessions.json"), redact.deep({ ...bindings, [thread.threadId]: binding }));
    });
  }
}

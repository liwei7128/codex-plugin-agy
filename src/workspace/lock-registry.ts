import fs from "node:fs";
import path from "node:path";
import { readJsonFile, withFileLock, writeJsonFile } from "../upstream/fs.mjs";
import { pathInWorkspace, containsPath, PluginError } from "../security/index.js";
import type { WorkspaceLease } from "./types.js";

export class LockRegistry {
  constructor(private readonly root: string) {}

  reserve(lease: WorkspaceLease, live: (lease: WorkspaceLease) => boolean): void {
    this.update(previous => {
      const active = previous.filter(live);
      const collision = active.some(entry => entry.sandbox === "workspace-write" && lease.sandbox === "workspace-write" &&
        (containsPath(entry.cwd, lease.cwd) || containsPath(lease.cwd, entry.cwd)));
      if (collision) throw new PluginError("WORKSPACE_WRITE_LOCKED", "Another job owns an overlapping write directory", {
        retryable: true, remediation: ["Wait for the job or use a separate worktree."],
      });
      const capacity = Math.min(lease.limit, ...active.map(entry => entry.limit));
      if (active.length >= capacity) throw new PluginError("CONCURRENCY_LIMIT_REACHED", "The worker concurrency limit was reached", { retryable: true });
      return [...active, lease];
    });
  }

  release(jobId: string): void {
    this.update(previous => previous.filter(entry => entry.jobId !== jobId));
  }

  private update(change: (active: WorkspaceLease[]) => WorkspaceLease[]): void {
    const file = pathInWorkspace(this.root, "locks.json", true);
    withFileLock(path.join(this.root, ".locks.lock"), () => {
      let leases: WorkspaceLease[] = [];
      try {
        if (fs.statSync(file).size > 1024 * 1024) throw new Error("Workspace lock registry is oversized");
        leases = readJsonFile(file);
        if (!Array.isArray(leases)) throw new Error("Invalid workspace lock registry");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      writeJsonFile(file, change(leases));
    });
  }
}

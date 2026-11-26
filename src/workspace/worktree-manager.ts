import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { workspaceKey } from "../config/index.js";
import { getRepoRoot, getWorkingTreeState } from "../upstream/git.mjs";
import { canonicalDirectory, pathInWorkspace, PluginError, samePath, SecretRedactor } from "../security/index.js";
import type { WorktreePlan } from "./types.js";

const redact = new SecretRedactor();
const idPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

export function planWorktree(dataRoot: string, anchor: string, cwd: string, jobId: string): WorktreePlan {
  if (!idPattern.test(jobId)) throw new PluginError("WORKTREE_ERROR", "Invalid worktree job ID");
  let gitRoot: string;
  try {
    gitRoot = getRepoRoot(cwd);
  } catch {
    throw new PluginError("NOT_A_GIT_REPO", "A Git repository is required for a worktree");
  }
  const repoRoot = canonicalDirectory(pathInWorkspace(anchor, gitRoot));
  const worktreePath = pathInWorkspace(dataRoot, path.join("worktrees", workspaceKey(repoRoot), jobId), true);
  return {
    repoRoot, worktreePath, branch: "codex-agy/" + jobId,
    effectiveCwd: path.join(worktreePath, path.relative(repoRoot, cwd)),
  };
}

function gitWorktree(plan: WorktreePlan, args: string[]) {
  const hooks = process.platform === "win32" ? "NUL" : "/dev/null";
  const result = spawnSync("git", ["-c", "core.hooksPath=" + hooks, "-c", "core.fsmonitor=false", "worktree", ...args],
    { cwd: plan.repoRoot, shell: false, windowsHide: true, encoding: "utf8", timeout: 20_000, maxBuffer: 128 * 1024 });
  if (result.status !== 0) {
    throw new PluginError("WORKTREE_ERROR", "Git could not update the isolated worktree", {
      details: { reason: redact.text(result.stderr || result.error?.message || "Git worktree failed").slice(0, 1000) },
    });
  }
}

export function provisionWorktree(plan: WorktreePlan): string[] {
  fs.mkdirSync(path.dirname(plan.worktreePath), { recursive: true, mode: 0o700 });
  const primaryWasDirty = getWorkingTreeState(plan.repoRoot).isDirty;
  gitWorktree(plan, ["add", "-b", plan.branch, "--", plan.worktreePath, "HEAD"]);
  canonicalDirectory(pathInWorkspace(plan.worktreePath, plan.effectiveCwd));
  return primaryWasDirty ? ["The worktree starts from HEAD. Uncommitted changes remain in the primary checkout."] : [];
}

export function removeCleanWorktree(dataRoot: string, plan: WorktreePlan): void {
  const root = pathInWorkspace(dataRoot, "worktrees");
  if (!samePath(pathInWorkspace(root, plan.worktreePath), plan.worktreePath) ||
      !idPattern.test(path.basename(plan.worktreePath)) || plan.branch !== "codex-agy/" + path.basename(plan.worktreePath) ||
      getWorkingTreeState(plan.worktreePath).isDirty) {
    throw new PluginError("WORKTREE_ERROR", "Only a clean plugin-owned worktree can be removed");
  }
  gitWorktree(plan, ["remove", "--", plan.worktreePath]);
}

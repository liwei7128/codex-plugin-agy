import type { Sandbox } from "../security/policy.js";

export interface WorkspaceLease {
  jobId: string;
  workspaceRoot: string;
  cwd: string;
  sandbox: Sandbox;
  recordFile: string;
  reservedAtMs: number;
  limit: number;
}

export interface WorktreePlan {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  effectiveCwd: string;
}

import type { ConfigOverrides } from "../config/index.js";
import type { ApprovalEvent, ProcessIdentity, ReviewTarget, RuntimeOutput } from "../runtime/index.js";
import type { ErrorInfo, SecurityPolicy } from "../security/index.js";

export const jobStates = ["queued", "starting", "running", "awaiting_approval", "completed", "failed",
  "cancelling", "cancelled", "timed_out", "interrupted"] as const;
export type JobState = typeof jobStates[number];
export const jobKinds = ["delegate", "review", "adversarial-review", "resume", "transfer"] as const;
export type JobKind = typeof jobKinds[number];

export interface JobRequest {
  kind: JobKind;
  cwd: string;
  prompt: string;
  explicit?: ConfigOverrides;
  threadId?: string;
  threadName?: string;
  ephemeral?: boolean;
  reviewTarget?: ReviewTarget;
  outputSchema?: unknown;
  allowedPaths?: string[];
  acceptanceCriteria?: string[];
  useWorktree?: boolean;
}

export interface JobRecord {
  id: string;
  state: JobState;
  workspaceRoot: string;
  effectiveCwd: string;
  request: JobRequest;
  launchToken: string;
  identity: ProcessIdentity | null;
  phase: string | null;
  createdAt: string;
  startedAt: string | null;
  lastProgressAt: string | null;
  completedAt: string | null;
  latestProgress: string | null;
  requestedModel: string;
  effectiveModel: string | null;
  reasoningEffort: string;
  threadId: string | null;
  turnId: string | null;
  policy: SecurityPolicy | null;
  pendingApproval: ApprovalEvent | null;
  interruptAcknowledged: boolean;
  error: ErrorInfo | null;
  output: RuntimeOutput | null;
  warnings: string[];
  worktreePath: string | null;
  worktreeBranch: string | null;
  outOfScopeFiles: string[];
  fileConflicts: string[];
}

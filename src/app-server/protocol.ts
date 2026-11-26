import type { ApprovalPolicy, CodexBaseline, Sandbox } from "../security/policy.js";

// Subset consumed by the plugin, checked against codex app-server generate-ts (0.172.0).
export type RpcId = number | string;
export interface RpcFailure { code: number; message: string; data?: unknown }
export interface RpcFrame {
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: RpcFailure;
}
export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";
export interface TurnError { message: string; codexErrorInfo?: unknown; additionalDetails?: string | null }
export interface Turn { id: string; status: TurnStatus; items?: ThreadItem[]; error?: TurnError | null }
export interface ThreadItem {
  type: string;
  id: string;
  [key: string]: unknown;
}
export interface Thread { id: string; cwd: string; ephemeral: boolean; status?: { type: string } }
export interface Model {
  id: string;
  model: string;
  hidden: boolean;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description?: string }>;
  defaultReasoningEffort: string;
}
export type ReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title: string | null }
  | { type: "custom"; instructions: string };
export type SandboxPolicy =
  | { type: "readOnly"; networkAccess: boolean }
  | { type: "workspaceWrite"; networkAccess: boolean; writableRoots: string[];
      excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean };

export interface ThreadParams {
  cwd: string;
  model: string;
  sandbox: Sandbox;
  approvalPolicy: ApprovalPolicy;
  approvalsReviewer?: "user";
  config?: Record<string, string | boolean | string[]>;
}
export interface StartedThread {
  thread: Thread;
  model: string;
  cwd: string;
  approvalPolicy: ApprovalPolicy;
  approvalsReviewer?: string;
  sandbox: SandboxPolicy;
  reasoningEffort: string | null;
}
export interface ConfigRead {
  config: CodexBaseline & { model_provider?: string | null };
  layers: Array<{ name: { type: string }; disabledReason?: string | null }> | null;
}
export interface AccountRead {
  account: { type: string } | null;
  requiresOpenaiAuth: boolean;
}
export interface TurnStart {
  threadId: string;
  input: Array<{ type: "text"; text: string; text_elements: [] }>;
  cwd?: string;
  approvalPolicy?: ApprovalPolicy;
  sandboxPolicy?: SandboxPolicy;
  model?: string;
  effort?: string;
  outputSchema?: unknown;
}

export interface AppServerMethods {
  "account/read": [{ refreshToken: boolean }, AccountRead];
  "config/read": [{ includeLayers: boolean; cwd: string }, ConfigRead];
  "model/list": [{ includeHidden?: boolean; modelProvider?: string; cursor?: string | null; limit?: number },
    { data: Model[]; nextCursor: string | null }];
  "thread/start": [ThreadParams & { serviceName: string; ephemeral: boolean }, StartedThread];
  "thread/resume": [ThreadParams & { threadId: string; excludeTurns: boolean }, StartedThread];
  "thread/read": [{ threadId: string; includeTurns: boolean }, { thread: Thread }];
  "thread/name/set": [{ threadId: string; name: string }, Record<string, never>];
  "thread/list": [{ cwd: string; limit?: number; sortKey?: "updated_at"; sourceKinds?: ["appServer"]; searchTerm?: string },
    { data: Thread[]; nextCursor: string | null }];
  "turn/start": [TurnStart, { turn: Turn }];
  "turn/interrupt": [{ threadId: string; turnId: string }, Record<string, never>];
  "review/start": [{ threadId: string; target: ReviewTarget; delivery: "inline" }, { turn: Turn; reviewThreadId: string }];
  "windowsSandbox/readiness": [undefined, { status: "ready" | "notConfigured" | "updateRequired" }];
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

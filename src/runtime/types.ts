import type { ApprovalEvent, BrokerOptions, CodexBinary, ReviewTarget, TurnError } from "../app-server/index.js";
import type { ConfigManager, ConfigOverrides } from "../config/index.js";
import type { SecurityPolicy } from "../security/policy.js";
export type { ApprovalEvent, ReviewTarget } from "../app-server/index.js";

export interface RuntimeProgress {
  message: string;
  phase: "starting" | "running" | "reviewing" | "editing" | "verifying" | "finalizing";
  threadId?: string;
  turnId?: string;
}
export interface RuntimeThread {
  threadId: string;
  workspaceRoot: string;
  cwd: string;
  ephemeral: boolean;
  requestedModel: string;
  effectiveModel: string;
  reasoningEffort: string;
  policy: SecurityPolicy;
}
export interface RuntimeOptions {
  cwd: string;
  workspaceRoot: string;
  prompt: string;
  explicit?: ConfigOverrides;
  threadId?: string;
  threadName?: string;
  ephemeral?: boolean;
  readOnly?: boolean;
  reviewTarget?: ReviewTarget;
  outputSchema?: unknown;
  signal?: AbortSignal;
  inheritedPolicy?: SecurityPolicy;
  onThread?: (thread: RuntimeThread) => void;
  onProgress?: (progress: RuntimeProgress) => void;
  onApproval?: (event: ApprovalEvent) => void;
  onInterrupt?: (acknowledged: boolean) => void;
}
export interface RuntimeContext {
  config: ConfigManager;
  binary?: CodexBinary;
  broker?: BrokerOptions;
}

export interface CommandEvidence {
  command: string;
  cwd: string | null;
  status: string | null;
  exitCode: number | null;
  durationMs: number | null;
  output: string | null;
}
export interface RuntimeOutput {
  turnId: string | null;
  finalResponse: string | null;
  completionInferred: boolean;
  modelRerouted: { fromModel: string; toModel: string; reason: unknown } | null;
  effectiveModel: string;
  tokenUsage: unknown | null;
  turnDiff: string | null;
  fileChanges: { path: string; kind: unknown }[];
  touchedFiles: string[];
  commandsExecuted: CommandEvidence[];
  testsExecuted: CommandEvidence[];
  reasoningSummary: string[];
  approvalEvents: ApprovalEvent[];
  structuredReview?: unknown;
  parseError?: string;
  rawOutput?: string | null;
  error: TurnError | null;
  interruptAcknowledged: boolean;
}
export interface RuntimeResult {
  thread: RuntimeThread;
  status: "completed" | "interrupted" | "awaiting_approval";
  output: RuntimeOutput;
  modelValidation: "verified" | "unverified_custom_provider";
}

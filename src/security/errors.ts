export const errorCodes = [
  "CODEX_NOT_INSTALLED", "CODEX_VERSION_UNSUPPORTED", "APP_SERVER_START_FAILED", "APP_SERVER_DISCONNECTED",
  "AUTH_REQUIRED", "AUTH_EXPIRED", "MODEL_UNAVAILABLE", "EFFORT_UNSUPPORTED", "POLICY_VIOLATION",
  "APPROVAL_REQUIRED", "INVALID_ARGUMENTS", "PATH_OUTSIDE_WORKSPACE", "SYMLINK_ESCAPE", "NOT_A_GIT_REPO",
  "WORKSPACE_WRITE_LOCKED", "CONCURRENCY_LIMIT_REACHED", "WORKTREE_ERROR", "JOB_NOT_FOUND", "JOB_AMBIGUOUS",
  "JOB_NOT_FINISHED", "JOB_NOT_CANCELABLE", "THREAD_NOT_FOUND", "THREAD_WORKSPACE_MISMATCH", "TIMEOUT",
  "PROTOCOL_MALFORMED_RESPONSE", "INTERNAL_ERROR",
] as const;

export type PluginErrorCode = typeof errorCodes[number];

export interface ErrorInfo {
  code: PluginErrorCode;
  message: string;
  retryable: boolean;
  remediation?: string[];
  details?: Record<string, unknown>;
}

export class PluginError extends Error {
  readonly code: PluginErrorCode;
  readonly retryable: boolean;
  readonly remediation?: string[];
  readonly details?: Record<string, unknown>;

  constructor(code: PluginErrorCode, message: string, options: Partial<Omit<ErrorInfo, "code" | "message">> = {}) {
    super(message);
    this.name = "PluginError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.remediation = options.remediation;
    this.details = options.details;
  }
}

export function errorInfo(error: unknown): ErrorInfo {
  const safeError = error instanceof PluginError
    ? error
    : new PluginError("INTERNAL_ERROR", error instanceof Error ? error.message : "Unexpected plugin failure");
  return {
    code: safeError.code, message: safeError.message, retryable: safeError.retryable,
    remediation: safeError.remediation, details: safeError.details,
  };
}

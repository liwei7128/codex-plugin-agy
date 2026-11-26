import { AppServerRpcError, asRecord, type TurnError } from "../app-server/index.js";
import { PluginError, SecretRedactor } from "../security/index.js";

const redact = new SecretRedactor();
const retryableCodes = new Set(["rateLimitExceeded", "serverOverloaded", "flexUnavailable", "httpConnectionFailed", "responseStreamDisconnected"]);
const budgetCodes = new Set(["usageLimitExceeded", "sessionBudgetExceeded", "contextWindowExceeded",
  "apiKeySpendLimitExceeded", "projectSpendLimitExceeded", "organizationSpendLimitExceeded"]);

export function runtimeError(error: unknown): PluginError {
  if (error instanceof PluginError) return error;
  const details = error instanceof AppServerRpcError ? asRecord(error.details) : asRecord(error);
  const info = details.codexErrorInfo;
  const kind = typeof info === "string" ? info : Object.keys(asRecord(info))[0];
  const raw = error instanceof Error ? error.message : (error as TurnError | null)?.message;
  const message = redact.text(typeof raw === "string" ? raw : "Codex execution failed").slice(0, 4096);
  if (kind === "modelNotFound" || /model.{0,50}(not found|unavailable|not supported)/i.test(message)) {
    return new PluginError("MODEL_UNAVAILABLE", message, { remediation: ["Verify model access through codex_setup."] });
  }
  if (kind === "unauthorized" || /\b401\b|unauthori[sz]ed|sign in|not logged in|auth.{0,20}expired/i.test(message)) {
    return new PluginError(/expired|refresh/i.test(message) ? "AUTH_EXPIRED" : "AUTH_REQUIRED", message,
      { remediation: ["Check the existing Codex login with codex login status."] });
  }
  if (kind === "sandboxError" || kind === "tooManyDenials") return new PluginError("POLICY_VIOLATION", message);
  if (kind === "badRequest") return new PluginError("INVALID_ARGUMENTS", message);
  const retryable = !!kind && retryableCodes.has(kind);
  return new PluginError("INTERNAL_ERROR", message, {
    retryable, details: kind ? { codexErrorInfo: kind } : undefined,
    remediation: kind && budgetCodes.has(kind) ? ["Check the active Codex account's quota or context budget."] : undefined,
  });
}

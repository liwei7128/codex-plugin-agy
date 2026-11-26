import type { JobRecord, JobState } from "../jobs/types.js";
import { SecretRedactor, utf8Page } from "../security/index.js";
import type { ErrorInfo } from "../security/index.js";

export interface ToolResponseEnvelope {
  ok: boolean;
  pluginMeta: Record<string, unknown> & { tool: string; schemaVersion: "1.0" };
  workerOutput: unknown;
  error?: ErrorInfo;
}

const redact = new SecretRedactor();
const active: JobState[] = ["queued", "starting", "running", "cancelling"];
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function clipText(value: string, limit: number): string {
  if (size(value) <= limit + 2) return value;
  let low = 0;
  let high = limit;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (size(utf8Page(value, 0, middle).text) <= limit + 2) low = middle;
    else high = middle - 1;
  }
  return utf8Page(value, 0, low).text;
}

export function pollIntervalMs(elapsedSeconds: number): number {
  return elapsedSeconds < 30 ? 5000 : elapsedSeconds < 120 ? 10_000 : 15_000;
}

export function jobMetadata(job: JobRecord) {
  const inProgress = active.includes(job.state);
  const elapsedSeconds = Math.max(0, Math.round(
    (Date.parse(job.completedAt ?? new Date().toISOString()) - Date.parse(job.startedAt ?? job.createdAt)) / 1000,
  ));
  const resumeCommand = job.threadId && !job.request.ephemeral && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(job.threadId)
    ? "codex resume " + job.threadId : null;
  return {
    jobId: job.id, kind: job.request.kind, state: job.state, phase: job.phase,
    requestedModel: job.requestedModel, effectiveModel: job.effectiveModel, reasoningEffort: job.reasoningEffort,
    sandbox: job.policy?.sandbox ?? null, approvalPolicy: job.policy?.approvalPolicy ?? null,
    threadId: job.threadId, turnId: job.turnId, workspaceRoot: job.workspaceRoot, effectiveCwd: job.effectiveCwd,
    worktreePath: job.worktreePath, worktreeBranch: job.worktreeBranch,
    modelRerouted: job.output?.modelRerouted ?? null, warnings: job.warnings,
    outOfScopeFiles: job.outOfScopeFiles, fileConflicts: job.fileConflicts,
    createdAt: job.createdAt, startedAt: job.startedAt, lastProgressAt: job.lastProgressAt,
    completedAt: job.completedAt, elapsedSeconds, latestProgress: job.latestProgress,
    pendingApproval: job.pendingApproval, interruptAcknowledged: job.interruptAcknowledged,
    resumeCommand, recommendedPollIntervalMs: inProgress ? pollIntervalMs(elapsedSeconds) : null,
    nextActions: inProgress ? ["codex_status", "codex_cancel"] : resumeCommand ? ["codex_result", "codex_resume"] : ["codex_result"],
  };
}

export interface DiffStat { files: string[]; insertions: number; deletions: number; source: "turn/diff/updated" }
export function diffStat(patch: string | null): DiffStat | null {
  if (patch === null) return null;
  const files: string[] = [];
  let inHunk = false;
  let insertions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (files.length < 100) files.push(line.slice(11, 523));
      inHunk = false;
    } else if (line.startsWith("@@ ")) {
      inHunk = true;
    } else if (inHunk && line.startsWith("+")) {
      insertions++;
    } else if (inHunk && line.startsWith("-")) {
      deletions++;
    }
  }
  return { files, insertions, deletions, source: "turn/diff/updated" };
}

export function envelope(
  tool: string,
  pluginMeta: Record<string, unknown> = {},
  workerOutput: unknown = null,
  error?: ErrorInfo,
  maxBytes = 16_384,
  outputCursor = 0,
  evidenceOffsets: { log?: number; diff?: number } = {},
): ToolResponseEnvelope {
  const response: ToolResponseEnvelope = redact.deep({
    ok: !error, pluginMeta: { ...pluginMeta, tool, schemaVersion: "1.0" },
    workerOutput: error ? null : workerOutput, ...(error ? { error } : {}),
  });
  const totalBytes = size(response);
  if (!outputCursor && totalBytes <= maxBytes) return response;

  const metadata = response.pluginMeta;
  const compact: ToolResponseEnvelope["pluginMeta"] = { tool, schemaVersion: "1.0" };
  const { logsChunk, nextLogCursor, nextDiffCursor, ...metadataSource } = metadata;
  const hasOutput = response.workerOutput !== null;
  const workerRecord = hasOutput && typeof response.workerOutput === "object" && !Array.isArray(response.workerOutput)
    ? response.workerOutput as Record<string, unknown> : undefined;
  const patch = workerRecord?.gitDiffPatch;
  const source = workerRecord && typeof patch === "string"
    ? Object.fromEntries(Object.entries(workerRecord).filter(([key]) => key !== "gitDiffPatch"))
    : hasOutput ? response.workerOutput : metadataSource;
  const raw = JSON.stringify(source);
  const output: Record<string, string> = {};
  const boundedResult: ToolResponseEnvelope = {
    ok: response.ok,
    pluginMeta: compact,
    workerOutput: hasOutput ? output : null,
    ...(response.error ? { error: { code: response.error.code, retryable: response.error.retryable,
      message: clipText(response.error.message, 100) } } : {}),
  };

  // Reserve space for the cursors and for progress in each requested byte stream.
  const pageTarget = hasOutput ? output : compact;
  const section = hasOutput ? "workerOutput" : "pluginMeta";
  const length = Buffer.byteLength(raw);
  const truncation = { truncated: true, totalBytes, returnedBytes: 0, nextCursor: length as number | null, section };
  compact.truncation = truncation;
  pageTarget.jsonChunk = "";
  if (typeof logsChunk === "string") { compact.logsChunk = ""; compact.nextLogCursor = nextLogCursor ?? null; }
  if (typeof patch === "string") { output.gitDiffPatch = ""; compact.nextDiffCursor = nextDiffCursor ?? null; }
  compact.metadataTruncated = true;
  const priorityBudget = maxBytes - 72;
  const add = (key: string, value: unknown) => {
    if (value === undefined) return true;
    compact[key] = value;
    if (size(boundedResult) <= priorityBudget) return true;
    delete compact[key];
    return false;
  };
  const textLimit = Math.max(48, Math.min(1024, Math.floor(maxBytes / 12)));
  const clip = (value: unknown, limit = textLimit) =>
    typeof value === "string" ? clipText(value, limit) : value;
  let clipped = false;
  for (const key of ["jobId", "state", "sandbox", "approvalPolicy", "worktreePath", "worktreeBranch",
    "modelRerouted", "pendingApproval", "outOfScopeFiles", "fileConflicts", "warnings"]) {
    const value = metadata[key];
    if (value === undefined) continue;
    let bounded = clip(value);
    if (Array.isArray(value)) {
      const count = value.length;
      const list = value.slice(0, maxBytes < 2048 ? 1 : 8).map(item => clip(item, Math.floor(textLimit / 2)));
      if (list.length < count || !add(key, list)) {
        add(key + "Count", count);
        while (list.length && !add(key, list)) list.pop();
      }
      bounded = list;
    } else {
      if (value && typeof value === "object" && size(value) > maxBytes / 8) {
        const record = value as Record<string, unknown>;
        if (key === "modelRerouted") bounded = { fromModel: clip(record.fromModel, 32), toModel: clip(record.toModel, 32) };
        if (key === "pendingApproval") bounded = { method: clip(record.method, 64) };
      }
      add(key, bounded);
    }
    if (!Object.hasOwn(compact, key) || JSON.stringify(bounded) !== JSON.stringify(value)) clipped = true;
  }
  if (!clipped) delete compact.metadataTruncated;
  for (const key of ["threadId", "turnId", "resumeCommand", "requestedModel", "effectiveModel",
    "interruptAcknowledged", "recommendedPollIntervalMs", "nextCursor"]) {
    add(key, clip(metadata[key], 160));
  }

  function payloadPage(text: string, offset: number, allowance: number, apply: (page: ReturnType<typeof utf8Page>) => void) {
    const cap = size(boundedResult) + allowance;
    let low = 0;
    let high = Math.min(Buffer.byteLength(text), allowance);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      apply(utf8Page(text, offset, middle));
      if (size(boundedResult) <= cap) low = middle;
      else high = middle - 1;
    }
    apply(utf8Page(text, offset, low));
  }
  const evidenceBudget = Math.floor((maxBytes - size(boundedResult)) / 3);
  if (typeof logsChunk === "string") payloadPage(logsChunk, 0, evidenceBudget, page => {
    compact.logsChunk = page.text;
    compact.nextLogCursor = page.nextCursor === null ? nextLogCursor ?? null : (evidenceOffsets.log ?? 0) + page.nextCursor;
  });
  if (typeof patch === "string") payloadPage(patch, 0, evidenceBudget, page => {
    output.gitDiffPatch = page.text;
    compact.nextDiffCursor = page.nextCursor === null ? nextDiffCursor ?? null : (evidenceOffsets.diff ?? 0) + page.nextCursor;
  });
  payloadPage(raw, outputCursor, maxBytes - size(boundedResult), page => {
    pageTarget.jsonChunk = page.text;
    truncation.returnedBytes = page.returnedBytes;
    truncation.nextCursor = page.nextCursor;
  });
  return boundedResult;
}

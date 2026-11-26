import type { z } from "zod";
import type { RuntimeContext } from "../runtime/index.js";
import type { ConfigOverrides } from "../config/index.js";
import { runSetup } from "../diagnostics/index.js";
import { diffStat, envelope, jobMetadata } from "../formatting/index.js";
import type { ToolResponseEnvelope } from "../formatting/index.js";
import { isActive, JobManager, latestLogLines, readLogChunk } from "../jobs/index.js";
import type { JobRecord, JobRequest } from "../jobs/index.js";
import { errorInfo, PluginError, utf8Page } from "../security/index.js";
import { coreSchemas } from "./schemas.js";

export type RegisterTool = <Schema extends z.ZodType>(
  name: string, description: string, schema: Schema,
  run: (input: z.output<Schema>, signal?: AbortSignal) => ToolResponseEnvelope | Promise<ToolResponseEnvelope>,
) => void;

export const mcpShutdown = Symbol("MCP transport shutdown");

export interface ToolContext {
  runtime: RuntimeContext;
  pluginRoot: string;
  workspace: (cwd?: string) => Promise<{ cwd: string; root: string; jobs: JobManager }>;
}

interface ExecutionArgs {
  model?: string; reasoning_effort?: string; sandbox?: "read-only" | "workspace-write";
  approval_policy?: "never" | "on-request" | "untrusted"; timeout_seconds?: number;
}

export function executionConfig(input: ExecutionArgs): ConfigOverrides {
  return {
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.reasoning_effort === undefined ? {} : { reasoningEffort: input.reasoning_effort }),
    ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
    ...(input.approval_policy === undefined ? {} : { approvalPolicy: input.approval_policy }),
    ...(input.timeout_seconds === undefined ? {} : { timeoutSeconds: input.timeout_seconds }),
  };
}

export async function submit(
  tool: string, jobs: JobManager, request: JobRequest, background: boolean | undefined, signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const job = jobs.create(request);
  if (background) return envelope(tool, jobMetadata(job));
  try {
    const finished = await jobs.wait(job.id, signal);
    return completedResponse(tool, finished);
  } catch (error) {
    if (signal?.aborted && signal.reason !== mcpShutdown) await jobs.cancel(job.id).catch(() => {});
    throw error;
  }
}

function completedResponse(tool: string, job: JobRecord) {
  const worker = job.output ? {
    ...job.output, turnDiff: undefined, gitDiffSummary: diffStat(job.output.turnDiff), threadId: job.threadId,
  } : null;
  return envelope(tool, jobMetadata(job), worker, job.error ?? undefined);
}

function pagingKey(job: JobRecord) {
  return job.createdAt + "/" + job.id;
}

export function registerCore(register: RegisterTool, context: ToolContext) {
  register("codex_setup", "Check the Codex version, existing login, requested model and effort, project trust, sandbox, and broker. Optional settings update the current workspace.",
    coreSchemas.setup, async input => {
      const { cwd, root } = await context.workspace(input.cwd);
      const updates: ConfigOverrides = {};
      if (input.orchestration_mode) updates.orchestrationMode = input.orchestration_mode;
      if (input.enable_review_gate || input.disable_review_gate) {
        updates.reviewGate = { enabled: input.enable_review_gate === true };
      }
      if (Object.keys(updates).length) context.runtime.config.update(updates, root);
      const info = await runSetup(context.runtime, root, cwd, executionConfig(input), input.probe_broker ?? true);
      return envelope("codex_setup", { workspaceRoot: root, readiness: info, updatedConfig: updates },
        null, info.errors[0]);
    });

  register("codex_delegate", "Delegate an authorized engineering task inside a workspace. Default read-only. Use background for long tasks and use_worktree for parallel writers. allowed_paths guides the worker and audits changes after the turn. Codex controls the OS sandbox.",
    coreSchemas.delegate, async (input, signal) => {
      const { cwd, jobs } = await context.workspace(input.cwd);
      return submit("codex_delegate", jobs, {
        kind: "delegate", cwd: input.thread_id && !input.cwd ? "" : cwd,
        prompt: input.task, explicit: executionConfig(input), threadId: input.thread_id,
        threadName: "Antigravity Task: " + input.task.slice(0, 56),
        allowedPaths: input.allowed_paths, acceptanceCriteria: input.acceptance_criteria, useWorktree: input.use_worktree,
      }, input.background, signal);
    });

  register("codex_status", "Read a job's progress, thread, state, and polling interval. Wait the recommended interval between active job queries.",
    coreSchemas.status, async input => {
      const { jobs } = await context.workspace(input.cwd);
      const job = jobs.get(input.job_id);
      return envelope("codex_status", {
        ...jobMetadata(job), progress: latestLogLines(jobs.store.file(job.id, ".log"), input.max_progress_lines ?? 8),
      }, null, job.error ?? undefined);
    });

  register("codex_result", "Retrieve a completed job result. Set include_logs or include_diff=patch to page through evidence using byte cursors.",
    coreSchemas.result, async input => {
      const { jobs } = await context.workspace(input.cwd);
      const job = jobs.get(input.job_id);
      const maxBytes = input.max_bytes ?? 16_384;
      if (isActive(job.state)) return envelope("codex_result", jobMetadata(job), null,
        errorInfo(new PluginError("JOB_NOT_FINISHED", "The job is still active", { retryable: true })), maxBytes);
      const evidenceBudget = Math.max(64, Math.floor(maxBytes / 4));
      const patch = input.include_diff === "patch" && job.output?.turnDiff !== null && job.output?.turnDiff !== undefined
        ? utf8Page(job.output.turnDiff, input.diff_cursor ?? 0, evidenceBudget) : null;
      const logs = input.include_logs
        ? readLogChunk(jobs.store.file(job.id, ".log"), input.log_cursor ?? 0, evidenceBudget) : null;
      const output = job.output ? {
        ...job.output, turnDiff: undefined, threadId: job.threadId,
        gitDiffSummary: input.include_diff === "none" ? undefined : diffStat(job.output.turnDiff),
        gitDiffPatch: patch?.text,
      } : null;
      return envelope("codex_result", {
        ...jobMetadata(job), logsChunk: logs?.text, nextLogCursor: logs?.nextCursor, nextDiffCursor: patch?.nextCursor,
      }, output, job.error ?? undefined, maxBytes, input.output_cursor ?? 0, {
        log: input.log_cursor, diff: input.diff_cursor,
      });
    });

  register("codex_cancel", "Cancel an active job by ID. Interrupts the owning Codex turn and reports the resulting job state.",
    coreSchemas.cancel, async input => {
      const { jobs } = await context.workspace(input.cwd);
      const job = await jobs.cancel(input.job_id, input.reason);
      return envelope("codex_cancel", jobMetadata(job), null, job.error ?? undefined);
    });

  register("codex_list_jobs", "List active or historical jobs in the current workspace. Use the returned cursor for the next page.",
    coreSchemas.list, async input => {
      const { jobs } = await context.workspace(input.cwd);
      const limit = input.limit ?? 15;
      const decoded = input.cursor ? Buffer.from(input.cursor, "base64url").toString("utf8") : "";
      if (decoded && !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\/[a-f0-9-]{36}$/.test(decoded)) {
        throw new PluginError("INVALID_ARGUMENTS", "Invalid job-list cursor");
      }
      const sorted = jobs.list().filter(job => {
        if (input.kind && job.request.kind !== input.kind) return false;
        if (decoded && pagingKey(job) >= decoded) return false;
        if (!input.state) return true;
        if (input.state === "active") return isActive(job.state);
        if (input.state === "terminal") return !isActive(job.state);
        return job.state === input.state;
      });
      const page = sorted.slice(0, limit);
      return envelope("codex_list_jobs", {
        jobs: page.map(job => ({
          jobId: job.id, kind: job.request.kind, state: job.state, createdAt: job.createdAt,
          threadId: job.threadId, requestedModel: job.requestedModel,
        })),
        nextCursor: sorted.length > limit ? Buffer.from(pagingKey(page[page.length - 1])).toString("base64url") : null,
      });
    });
}

import { z } from "zod";
import { jobKinds, jobStates } from "../jobs/index.js";

export const safeText = (max: number) => z.string().min(1).max(max).refine(
  value => Buffer.byteLength(value) <= max, { message: "Exceeds UTF-8 byte limit" },
);
export const cwd = safeText(4096).optional();
export const model = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/).optional();
export const reasoning_effort = model;
export const sandbox = z.enum(["read-only", "workspace-write"]).optional();
export const approval_policy = z.enum(["never", "on-request", "untrusted"]).optional();
export const background = z.boolean().optional();
export const timeout_seconds = z.number().int().min(10).max(3600).optional();
export const thread_id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const job_id = z.string().regex(/^[a-f0-9-]{1,36}$/);
export const paths = z.array(safeText(4096)).max(64).optional();
export const criteria = z.array(safeText(2048)).max(32).optional();
export const task = safeText(64 * 1024);

export const execution = { cwd, model, reasoning_effort, background, timeout_seconds };
export const scopes = { sandbox, approval_policy, allowed_paths: paths, acceptance_criteria: criteria };

export const coreSchemas = {
  setup: z.strictObject({
    cwd, model, reasoning_effort, enable_review_gate: z.boolean().optional(), disable_review_gate: z.boolean().optional(),
    orchestration_mode: z.enum(["assisted", "delegated", "review", "parallel"]).optional(), probe_broker: z.boolean().optional(),
  }).refine(args => !(args.enable_review_gate && args.disable_review_gate), { message: "Review Gate toggles are mutually exclusive" }),
  delegate: z.strictObject({ ...execution, ...scopes, task, thread_id: thread_id.optional(), use_worktree: z.boolean().optional() }),
  status: z.strictObject({ cwd, job_id, max_progress_lines: z.number().int().min(0).max(50).optional() }),
  result: z.strictObject({
    cwd, job_id, include_diff: z.enum(["none", "stat", "patch"]).optional(), include_logs: z.boolean().optional(),
    log_cursor: z.number().int().min(0).max(2 ** 30).optional(), diff_cursor: z.number().int().min(0).max(2 ** 30).optional(),
    output_cursor: z.number().int().min(0).max(2 ** 30).optional(), max_bytes: z.number().int().min(1024).max(65_536).optional(),
  }),
  cancel: z.strictObject({ cwd, job_id, reason: safeText(2048).optional() }),
  list: z.strictObject({
    cwd, state: z.enum([...jobStates, "active", "terminal"]).optional(), kind: z.enum(jobKinds).optional(),
    limit: z.number().int().min(1).max(50).optional(), cursor: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/).optional(),
  }),
};

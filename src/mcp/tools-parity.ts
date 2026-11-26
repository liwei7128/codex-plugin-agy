import { z } from "zod";
import { prepareReview } from "../runtime/review.js";
import { prepareHandoff } from "../runtime/transfer.js";
import { executionConfig, submit, type RegisterTool, type ToolContext } from "./tools-core.js";
import { criteria, cwd, execution, model, paths, reasoning_effort, safeText, scopes, task, thread_id } from "./schemas.js";

const reviewArgs = {
  ...execution,
  scope: z.enum(["auto", "uncommitted", "staged", "branch", "commit"]).optional(),
  base: safeText(256).optional(), commit: safeText(256).optional(), paths, instructions: safeText(8192).optional(),
};
const nativeSchema = z.strictObject(reviewArgs);
const adversarialSchema = z.strictObject({ ...reviewArgs, focus: safeText(8192).optional() });
const resumeSchema = z.strictObject({ ...execution, ...scopes, thread_id, task });
const transferSchema = z.strictObject({
  cwd, model, reasoning_effort, objective: safeText(8192), summary: safeText(32768),
  architecture_decisions: criteria, constraints: criteria, relevant_files: paths, previous_attempts: criteria,
  unresolved_issues: criteria, acceptance_criteria: criteria,
});

export function registerParity(register: RegisterTool, context: ToolContext) {
  register("codex_review", "Review Git changes in a read-only turn. Choose staged, uncommitted, branch, commit, selected files, or custom instructions. Use native Codex review where supported.",
    nativeSchema, async (input, signal) => {
      const { root, cwd, jobs } = await context.workspace(input.cwd);
      const plan = prepareReview(root, cwd, context.pluginRoot, input, false);
      return submit("codex_review", jobs, { ...plan, kind: "review", explicit: executionConfig(input), ephemeral: true }, input.background, signal);
    });

  register("codex_adversarial_review", "Perform a defensive, read-only code review for material correctness, security, and regression risks. Returns evidence-backed findings in severity order.",
    adversarialSchema, async (input, signal) => {
      const { root, cwd, jobs } = await context.workspace(input.cwd);
      const plan = prepareReview(root, cwd, context.pluginRoot, input, true);
      return submit("codex_adversarial_review", jobs, { ...plan, kind: "adversarial-review",
        explicit: executionConfig(input), ephemeral: true }, input.background, signal);
    });

  register("codex_resume", "Continue a persistent thread previously created in the selected workspace. Omit cwd to reuse the bound directory.",
    resumeSchema, async (input, signal) => {
      const { cwd, jobs } = await context.workspace(input.cwd);
      return submit("codex_resume", jobs, {
        kind: "resume", cwd: input.cwd ? cwd : "", prompt: input.task, explicit: executionConfig(input), threadId: input.thread_id,
        allowedPaths: input.allowed_paths, acceptanceCriteria: input.acceptance_criteria,
      }, input.background, signal);
    });

  register("codex_transfer", "Seed a persistent read-only Codex thread from the handoff you supply. Returns the thread and its CLI resume command.",
    transferSchema, async (input, signal) => {
      const { cwd: requestedCwd, model: requestedModel, reasoning_effort: effort, ...handoff } = input;
      const { cwd, jobs } = await context.workspace(requestedCwd);
      return submit("codex_transfer", jobs, {
        ...prepareHandoff(cwd, handoff), cwd, kind: "transfer", explicit: executionConfig({ model: requestedModel, reasoning_effort: effort }),
      }, false, signal);
    });
}

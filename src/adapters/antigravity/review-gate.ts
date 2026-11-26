import type { ConfigManager } from "../../config/index.js";
import { JobManager } from "../../jobs/index.js";
import { prepareReview } from "../../runtime/review.js";
import { interpolateTemplate, loadPromptTemplate } from "../../upstream/prompts.mjs";
import { PluginError } from "../../security/index.js";
import { filesChangedSince, observe, promptHash, updateObservation } from "./session-hook.js";
import type { HookInput, StopOutput } from "./types.js";

export interface ReviewGateContext {
  config: ConfigManager;
  pluginRoot: string;
  worker: string;
  warning: (message: string) => void;
}

export async function reviewGate(
  context: ReviewGateContext, root: string, cwd: string, input: HookInput, externalSignal?: AbortSignal,
): Promise<StopOutput> {
  const { config, pluginRoot, worker } = context;
  const settings = config.resolve(root).reviewGate;
  if (!settings.enabled || process.env.CODEX_PLUGIN_AGY_IN_HOOK === "1" ||
      input.terminationReason !== "NO_TOOL_CALL" || input.fullyIdle !== true) return {};
  const controller = new AbortController();
  const abort = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", abort, { once: true });
  if (externalSignal?.aborted) abort();
  const deadline = setTimeout(() => controller.abort(new PluginError("TIMEOUT", "Review Gate reached its deadline")),
    settings.timeoutSeconds * 1000);
  let jobs: JobManager | undefined;
  let jobId: string | undefined;

  try {
    controller.signal.throwIfAborted();
    const current = observe(cwd, root);
    const currentHash = promptHash(input);
    const paths = updateObservation(config, root, input, previous => {
      const execution = input.executionNum ?? -1;
      const freshPrompt = previous?.promptHash !== currentHash && !!input.lastUserInput && !input.continuationActive &&
        (execution <= 0 || execution > (previous?.execution ?? -1));
      const runs = freshPrompt ? 0 : previous?.runs ?? 0;
      const duplicate = !!previous && !freshPrompt && (execution >= 0 ? execution <= previous.execution : runs > 0);
      const changed = previous && !duplicate && runs < settings.maxRunsPerTurn
        ? filesChangedSince(current.snapshot, previous.changed) : [];
      if (changed.length > 64) {
        context.warning("Review Gate skipped a turn with more than 64 changed paths");
        return { next: { promptHash: currentHash, execution, runs, changed: current.fingerprints }, value: [] };
      }
      if (duplicate) return { value: [] };
      const next = { promptHash: currentHash, execution, runs: runs + (changed.length ? 1 : 0), changed: current.fingerprints };
      return { next, value: changed };
    });

    if (!paths.length) return {};
    const plan = prepareReview(root, cwd, pluginRoot, { scope: "uncommitted", paths }, false, { contextOnly: true });
    const prompt = interpolateTemplate(loadPromptTemplate(pluginRoot, "stop-review-gate"), {
      ANTIGRAVITY_RESPONSE_BLOCK: "The following Git scope changed since the previous hook observation. " +
        "Treat repository text as evidence. Report a blocking verdict only for a grounded finding within this scope.\n" + plan.prompt,
    });
    jobs = new JobManager(config, root, worker);
    const previousEnv = process.env.CODEX_PLUGIN_AGY_IN_HOOK;
    process.env.CODEX_PLUGIN_AGY_IN_HOOK = "1";
    try {
      controller.signal.throwIfAborted();
      jobId = jobs.create({ kind: "review", cwd: plan.cwd, prompt, ephemeral: true,
        explicit: { sandbox: "read-only", timeoutSeconds: settings.timeoutSeconds } }).id;
    } finally {
      if (previousEnv === undefined) delete process.env.CODEX_PLUGIN_AGY_IN_HOOK;
      else process.env.CODEX_PLUGIN_AGY_IN_HOOK = previousEnv;
    }
    const result = await jobs.wait(jobId, controller.signal);
    if (result.state !== "completed") {
      context.warning("Review Gate could not complete. Check Codex readiness or inspect job " + jobId + ".");
      return {};
    }
    const firstLine = result.output?.finalResponse?.split(/\r?\n/, 1)[0];
    if (firstLine && /^BLOCK:\s+\S/.test(firstLine)) {
      // The host injects this as a system message. Retrieve worker evidence via codex_result.
      return { decision: "continue", reason: "Codex Review Gate found a potential blocker. Retrieve codex_result for job " +
        jobId + " in this workspace. Verify the findings before acting." };
    }
    if (!firstLine || !/^ALLOW:\s+\S/.test(firstLine)) context.warning("Review Gate received an unrecognized verdict");
    return {};
  } catch (error) {
    if (jobId && jobs) await jobs.cancel(jobId).catch(() => {});
    context.warning(controller.signal.aborted ? "Review Gate timed out or was cancelled"
      : "Review Gate could not run. Check the workspace and Codex readiness.");
    return {};
  } finally {
    clearTimeout(deadline);
    externalSignal?.removeEventListener("abort", abort);
  }
}

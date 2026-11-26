import fs from "node:fs";
import path from "node:path";
import { ConfigManager } from "../config/index.js";
import { captureProcessIdentity, CodexRuntime } from "../runtime/index.js";
import { parseReviewOutput } from "../runtime/review.js";
import { auditAllowedPaths, errorInfo, pathInWorkspace, PluginError, SecretRedactor } from "../security/index.js";
import { SessionManager } from "../sessions/index.js";
import { changedSince, LockRegistry, planWorktree, provisionWorktree, snapshotChanges } from "../workspace/index.js";
import { appendLog } from "./log-store.js";
import { JobStore } from "./state-store.js";
import type { JobRecord } from "./types.js";

const redact = new SecretRedactor();
const drivingStates = ["starting", "running"] as const;

function createPrompt(job: JobRecord, scope: string[]) {
  const blocks = [job.request.prompt];
  if (scope.length) {
    blocks.push("<scope_constraint>\nRestrict edits to these paths. The plugin audits changes after the turn.\n" +
      JSON.stringify(scope) + "\n</scope_constraint>");
  }
  if (job.request.acceptanceCriteria?.length) {
    blocks.push("<acceptance_criteria>\n" + JSON.stringify(job.request.acceptanceCriteria) + "\n</acceptance_criteria>");
  }
  return blocks.join("\n\n");
}

async function main(workspaceRoot: string, id: string, launchToken: string, brokerScript: string) {
  if (!/^[a-f0-9]{32}$/.test(launchToken)) throw new Error("Invalid task worker launch");
  const config = new ConfigManager();
  const store = new JobStore(config.root, config.workspaceDirectory(workspaceRoot));
  const job = store.get(id);
  if (!job || job.launchToken !== launchToken) throw new Error("Job launch record does not match");
  const sessions = new SessionManager(workspaceRoot, store.directory);
  const locks = new LockRegistry(config.root);
  const now = () => new Date().toISOString();
  if (job.state === "cancelling") {
    store.update(id, ["cancelling"], { state: "cancelled", completedAt: now() });
    locks.release(id);
    return;
  }

  const controller = new AbortController();
  const cancel = () => controller.abort(new PluginError("JOB_NOT_CANCELABLE", "Worker cancellation requested"));
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);
  const identity = captureProcessIdentity(process.pid, launchToken, Date.now() - process.uptime() * 1000);
  if (!store.update(id, ["queued"], { state: "starting", identity, startedAt: now(), phase: "starting" })) return;
  const log = (message: string) => appendLog(store.file(id, ".log"), now() + " " + message);

  const timer = setInterval(() => {
    try {
      if (fs.existsSync(store.file(id, ".cancel")) || store.get(id)?.state === "cancelling") cancel();
    } catch (error) {
      controller.abort(error);
    }
  }, 250);
  timer.unref();

  try {
    const request = job.request;
    const warnings = [...job.warnings];
    if (job.worktreePath) pathInWorkspace(config.root, job.worktreePath, true);
    if (request.useWorktree) {
      warnings.push(...provisionWorktree(planWorktree(config.root, workspaceRoot, request.cwd, id)));
      store.update(id, ["starting"], { warnings });
    }
    const cwd = pathInWorkspace(job.worktreePath ?? workspaceRoot, job.effectiveCwd);
    const scope = (request.allowedPaths ?? []).map(entry => path.relative(cwd, pathInWorkspace(cwd, entry, true)) || ".");
    const before = scope.length ? snapshotChanges(cwd, job.worktreePath ?? workspaceRoot) : new Map<string, string>();
    const binding = request.threadId ? sessions.require(request.threadId, cwd) : undefined;
    const explicit = binding ? {
      sandbox: binding.policy.sandbox, model: binding.requestedModel, reasoningEffort: binding.reasoningEffort,
      ...request.explicit,
    } : request.explicit;
    const result = await new CodexRuntime({
      config, broker: { dataRoot: config.root, script: brokerScript },
    }).execute({
      workspaceRoot, cwd, prompt: createPrompt(job, scope), explicit, threadId: request.threadId,
      inheritedPolicy: binding?.policy, signal: controller.signal, ephemeral: request.ephemeral,
      threadName: request.threadName, reviewTarget: request.reviewTarget, outputSchema: request.outputSchema,
      readOnly: request.kind === "review" || request.kind === "adversarial-review" || request.kind === "transfer",
      onThread: thread => {
        if (!thread.ephemeral) sessions.bind(thread, id, job.worktreePath);
        store.update(id, drivingStates, {
          threadId: thread.threadId, requestedModel: thread.requestedModel, effectiveModel: thread.effectiveModel,
          reasoningEffort: thread.reasoningEffort, policy: thread.policy,
        });
      },
      onProgress: progress => {
        log(progress.message);
        store.update(id, drivingStates, {
          ...(progress.turnId ? { state: "running", turnId: progress.turnId } : {}),
          phase: progress.phase, latestProgress: progress.message, lastProgressAt: now(),
        });
      },
      onApproval: approval => {
        log("Codex requested interactive approval");
        store.update(id, drivingStates, { pendingApproval: approval, lastProgressAt: now() });
      },
      onInterrupt: acknowledged => store.update(id, [...drivingStates, "cancelling"], { interruptAcknowledged: acknowledged }),
    });

    const output = result.output;
    const authoritativeCompletion = result.status === "completed" && !output.completionInferred;
    if (authoritativeCompletion) store.update(id, [...drivingStates, "cancelling"], { phase: "finalizing" });
    if (request.kind === "adversarial-review" && result.status === "completed") {
      Object.assign(output, parseReviewOutput(output.finalResponse));
    }
    const changes = scope.length ? changedSince(cwd, before, job.worktreePath ?? workspaceRoot) : [];
    const outOfScopeFiles = auditAllowedPaths(cwd, scope, [...output.touchedFiles, ...changes]);
    if (outOfScopeFiles.length) warnings.push("File changes exceeded the requested task scope");
    if (result.modelValidation === "unverified_custom_provider") warnings.push("Model catalog could not verify the configured custom provider");
    if (output.modelRerouted) warnings.push("Codex reported a model reroute");
    const state = result.status;
    if (state === "completed") store.update(id, ["starting"], { state: "running", turnId: output.turnId });
    const expected = authoritativeCompletion ? ["running", "cancelling"] as const : drivingStates;
    if (!store.update(id, expected, {
      state, phase: state, completedAt: now(),
      output: state === "completed" ? output : null,
      effectiveModel: output.effectiveModel, turnId: output.turnId,
      pendingApproval: output.approvalEvents[0] ?? null, warnings, outOfScopeFiles,
      error: state === "awaiting_approval" ? errorInfo(new PluginError("APPROVAL_REQUIRED", "Interactive approval is required")) : null,
    })) {
      store.update(id, ["cancelling"], { state: "cancelled", phase: "cancelled", completedAt: now() });
    }
  } catch (failure) {
    const error = redact.deep(errorInfo(failure));
    log(error.message);
    if (!store.update(id, ["cancelling"], { state: "cancelled", phase: "cancelled", completedAt: now() })) {
      const state = error.code === "TIMEOUT" ? "timed_out" : error.code === "APP_SERVER_DISCONNECTED" ? "interrupted" : "failed";
      store.update(id, drivingStates, { state, phase: state, error, completedAt: now() });
    }
  } finally {
    clearInterval(timer);
    fs.rmSync(store.file(id, ".cancel"), { force: true });
    locks.release(id);
  }
}

export function runWorker(brokerScript: string): void {
  const [, , workspace, id, token] = process.argv;
  main(workspace, id, token, brokerScript).catch(error => {
    process.stderr.write(redact.text(error instanceof Error ? error.message : "Detached task worker failed") + "\n");
    process.exitCode = 1;
  });
}

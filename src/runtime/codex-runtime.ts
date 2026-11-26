import { setTimeout as delay } from "node:timers/promises";
import {
  asRecord, connectAppServer, type AppServerClient, type ConfigRead, type StartedThread,
  type ThreadItem, type Turn, type AccountRead, type ApprovalEvent,
} from "../app-server/index.js";
import {
  assertSafeOption, canonicalDirectory, containsPath, isApprovalPolicy, PluginError,
  resolvePolicy, sameApprovalPolicy, samePath, SecretRedactor, stricterApproval, utf8Page,
} from "../security/index.js";
import { validateModel } from "./model-validator.js";
import { runtimeError } from "./error-mapper.js";
import type { RuntimeContext, RuntimeOptions, RuntimeOutput, RuntimeResult, RuntimeThread, CommandEvidence } from "./types.js";

export const SERVICE_NAME = "antigravity_codex_plugin";
const redactor = new SecretRedactor();

export function checkAccount(account: AccountRead): "chatgpt" | "apiKey" | "custom_provider" {
  if (account?.account?.type === "chatgpt" || account?.account?.type === "apiKey") return account.account.type;
  if (account?.requiresOpenaiAuth === false) return "custom_provider";
  if (account?.requiresOpenaiAuth !== true) {
    throw new PluginError("PROTOCOL_MALFORMED_RESPONSE", "Invalid account/read response");
  }
  throw new PluginError("AUTH_REQUIRED", "Codex requires an existing login", {
    remediation: ["Run codex login with an authorized account, then repeat setup."],
  });
}

export function readBaseline(response: ConfigRead) {
  if (!response?.config || !Object.hasOwn(response.config, "sandbox_mode") ||
      !Object.hasOwn(response.config, "approval_policy")) {
    throw new PluginError("PROTOCOL_MALFORMED_RESPONSE", "The effective Codex security configuration could not be verified");
  }
  return response.config;
}

function bounded(text: unknown, max = 4096): string | null {
  return typeof text === "string" ? utf8Page(redactor.text(text), 0, max).text : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

// [codex-plugin-agy] Adapted from the upstream captureTurn and inferred completion drain.
async function captureTurn(
  client: AppServerClient, thread: RuntimeThread, options: RuntimeOptions, signal: AbortSignal,
): Promise<{ status: RuntimeResult["status"]; output: RuntimeOutput }> {
  const threadId = thread.threadId;
  const output: RuntimeOutput = {
    turnId: null, finalResponse: null, completionInferred: false, modelRerouted: null,
    effectiveModel: thread.effectiveModel, tokenUsage: null, turnDiff: null, fileChanges: [], touchedFiles: [],
    commandsExecuted: [], testsExecuted: [], reasoningSummary: [], approvalEvents: [], error: null,
    interruptAcknowledged: false,
  };
  const tracked = new Map<string, string | null>([[threadId, null]]);
  const childTurns = new Set<string>();
  const collaboration = new Set<string>();
  const seen = new Set<string>();
  let finalAnswer = false;
  let drain: NodeJS.Timeout | undefined;
  let resolveCompletion!: (turn: Turn | null) => void;
  let rejectCompletion!: (error: unknown) => void;
  let terminalTurn: Turn | undefined;
  let resolveTerminal!: (turn: Turn) => void;
  const terminalEvent = new Promise<Turn>(resolve => { resolveTerminal = resolve; });
  const complete = new Promise<Turn | null>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
  // A notification or disconnect can precede the turn-start reply.
  void complete.catch(() => {});

  function recordTerminal(turn: Turn) {
    terminalTurn ??= turn;
    resolveTerminal(turn);
    resolveCompletion(turn);
  }

  function scheduleDrain() {
    clearTimeout(drain);
    if (finalAnswer && !childTurns.size && !collaboration.size && output.turnId) {
      drain = setTimeout(() => {
        output.completionInferred = true;
        resolveCompletion(null);
      }, 250);
    }
  }

  function recordItem(item: ThreadItem, threadKey: string, started: boolean) {
    if (!item || typeof item.type !== "string" || typeof item.id !== "string") return;
    if (item.type === "collabAgentToolCall") {
      if (started) collaboration.add(item.id);
      else collaboration.delete(item.id);
      if (Array.isArray(item.receiverThreadIds)) {
        for (const id of item.receiverThreadIds.slice(0, 64)) {
          if (typeof id === "string" && !tracked.has(id) && tracked.size < 100) tracked.set(id, null);
        }
      }
      scheduleDrain();
    }
    if (started) {
      if (item.type === "commandExecution") options.onProgress?.({ phase: "running", message: "Running a Codex command" });
      if (item.type === "fileChange") options.onProgress?.({ phase: "editing", message: "Applying file changes" });
      if (item.type === "enteredReviewMode") options.onProgress?.({ phase: "reviewing", message: "Native review started" });
      return;
    }
    const key = threadKey + "/" + item.id;
    if (seen.has(key) || seen.size >= 2000) return;
    seen.add(key);
    if (threadKey === threadId && (item.type === "agentMessage" || item.type === "exitedReviewMode")) {
      const final = item.type === "exitedReviewMode" || item.phase === "final_answer";
      const message = bounded(item.type === "exitedReviewMode" ? item.review : item.text, 160 * 1024);
      if (message && (final || !finalAnswer)) output.finalResponse = message;
      finalAnswer ||= final;
      if (final) {
        options.onProgress?.({ phase: "finalizing", message: "Final answer received" });
        scheduleDrain();
      }
    }
    if (item.type === "fileChange" && Array.isArray(item.changes)) {
      for (const change of item.changes.slice(0, 200 - output.fileChanges.length)) {
        const record = asRecord(change);
        const file = bounded(record.path, 1024);
        if (!file) continue;
        output.fileChanges.push({ path: file, kind: redactor.deep(record.kind) });
        if (!output.touchedFiles.includes(file)) output.touchedFiles.push(file);
      }
    }
    if (item.type === "commandExecution" && output.commandsExecuted.length < 150) {
      const command = bounded(item.command);
      if (!command) return;
      const evidence: CommandEvidence = {
        command, cwd: bounded(item.cwd, 1024), status: bounded(item.status, 100),
        exitCode: nullableNumber(item.exitCode), durationMs: nullableNumber(item.durationMs),
        output: bounded(item.aggregatedOutput, 4096),
      };
      output.commandsExecuted.push(evidence);
      if (/\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|tsc|eslint|ruff)\b/i.test(command)) {
        output.testsExecuted.push(evidence);
      }
    }
    if (item.type === "reasoning" && Array.isArray(item.summary)) {
      for (const part of item.summary.slice(0, 50 - output.reasoningSummary.length)) {
        const line = bounded(part);
        if (line) output.reasoningSummary.push(line);
      }
    }
  }

  function setTurn(id: string) {
    if (!output.turnId) {
      output.turnId = id;
      tracked.set(threadId, id);
      options.onProgress?.({ phase: "running", message: "Codex turn started", threadId, turnId: id });
    } else if (output.turnId !== id) {
      throw new PluginError("PROTOCOL_MALFORMED_RESPONSE", "App Server returned an unexpected turn identifier");
    }
  }

  const onNotification = (method: string, payload: unknown) => {
    const params = asRecord(payload);
    if (method === "thread/started") {
      const child = asRecord(params.thread);
      if (typeof child.id === "string" && typeof child.parentThreadId === "string" &&
          tracked.has(child.parentThreadId) && !tracked.has(child.id) && tracked.size < 100) tracked.set(child.id, null);
      return;
    }
    const id = params.threadId;
    if (typeof id !== "string" || !tracked.has(id)) return;
    const turn = asRecord(params.turn);
    const turnId = params.turnId ?? turn.id;
    const known = tracked.get(id);
    if (known && typeof turnId === "string" && known !== turnId) return;
    if (method === "turn/started" && typeof turnId === "string") {
      if (id === threadId) setTurn(turnId);
      else {
        tracked.set(id, turnId);
        childTurns.add(id);
        scheduleDrain();
      }
    } else if (method === "turn/completed" && typeof turnId === "string") {
      if (id === threadId) {
        setTurn(turnId);
        const completed = turn as unknown as Turn;
        for (const item of completed.items ?? []) recordItem(item, id, false);
        clearTimeout(drain);
        recordTerminal(completed);
      } else {
        childTurns.delete(id);
        tracked.set(id, null);
        scheduleDrain();
      }
    } else if (method === "item/started" || method === "item/completed") {
      recordItem(params.item as ThreadItem, id, method === "item/started");
    } else if (id === threadId && method === "thread/tokenUsage/updated") {
      output.tokenUsage = redactor.deep(params.tokenUsage ?? null);
    } else if (id === threadId && method === "turn/diff/updated") {
      output.turnDiff = bounded(params.diff, 256 * 1024);
    } else if (id === threadId && method === "model/rerouted" &&
        typeof params.fromModel === "string" && typeof params.toModel === "string") {
      output.effectiveModel = bounded(params.toModel, 200) ?? output.effectiveModel;
      output.modelRerouted = redactor.deep({ fromModel: params.fromModel, toModel: params.toModel, reason: params.reason });
    } else if (id === threadId && method === "error") {
      const error = asRecord(params.error);
      if (typeof error.message === "string") output.error = redactor.deep(error) as unknown as RuntimeOutput["error"];
    }
  };

  let wakeApproval!: () => void;
  const approvalReceived = new Promise<void>(resolve => { wakeApproval = resolve; });
  const onApproval = (event: ApprovalEvent) => {
    if (event.params.threadId && typeof event.params.threadId === "string" && !tracked.has(event.params.threadId)) return;
    if (output.approvalEvents.length >= 10) return;
    output.approvalEvents.push(redactor.deep(event));
    options.onApproval?.(event);
    wakeApproval();
  };

  async function interrupt() {
    if (terminalTurn) return terminalTurn;
    if (!output.turnId || !client.alive) return undefined;
    try {
      await client.request("turn/interrupt", { threadId, turnId: output.turnId }, 1500);
      output.interruptAcknowledged = true;
    } catch {
      // A completed turn can race with the interrupt RPC and reject it.
    } finally {
      options.onInterrupt?.(output.interruptAcknowledged);
    }
    return Promise.race([terminalEvent, delay(1250, undefined, { ref: false })]);
  }

  client.on("notification", onNotification);
  client.on("approval", onApproval);
  client.on("disconnect", rejectCompletion);
  try {
    signal.throwIfAborted();
    const policy = thread.policy;
    const start = options.reviewTarget
      ? client.request("review/start", { threadId, target: options.reviewTarget, delivery: "inline" })
      : client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: options.prompt, text_elements: [] }],
        model: thread.requestedModel,
        effort: thread.reasoningEffort,
        approvalPolicy: policy.approvalPolicy,
        sandboxPolicy: policy.sandbox === "read-only"
          ? { type: "readOnly", networkAccess: false }
          : { type: "workspaceWrite", networkAccess: policy.networkAccess, writableRoots: [],
              excludeTmpdirEnvVar: true, excludeSlashTmp: true },
        outputSchema: options.outputSchema,
      });
    const started = await abortable(start, signal);
    if (!started?.turn || typeof started.turn.id !== "string") {
      throw new PluginError("PROTOCOL_MALFORMED_RESPONSE", "Missing turn in App Server response");
    }
    setTurn(started.turn.id);
    for (const item of started.turn.items ?? []) recordItem(item, threadId, false);
    if (started.turn.status !== "inProgress") {
      recordTerminal(started.turn);
    }

    const terminal = await abortable(Promise.race([complete, approvalReceived]), signal);
    if (output.approvalEvents.length) {
      if (terminal === undefined) await interrupt();
      return { status: "awaiting_approval", output };
    }
    if (!terminal && !output.completionInferred) throw new PluginError("INTERNAL_ERROR", "Codex did not complete the turn");
    if (terminal?.status === "failed") throw runtimeError(terminal.error ?? output.error);
    if (terminal?.status === "interrupted") return { status: "interrupted", output };
    if (terminal && terminal.status !== "completed") {
      throw new PluginError("PROTOCOL_MALFORMED_RESPONSE", "Invalid completed-turn status");
    }
    return { status: "completed", output };
  } catch (error) {
    if (signal.aborted) {
      const terminal = await interrupt();
      if (terminal?.status === "completed" && !output.approvalEvents.length) {
        output.completionInferred = false;
        return { status: "completed", output };
      }
    }
    throw error;
  } finally {
    clearTimeout(drain);
    client.off("notification", onNotification);
    client.off("approval", onApproval);
    client.off("disconnect", rejectCompletion);
  }
}

function verifyThread(started: StartedThread, thread: Omit<RuntimeThread, "threadId" | "effectiveModel">, canonicalModel?: string) {
  if (!started?.thread || typeof started.thread.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(started.thread.id)) {
    throw new PluginError("PROTOCOL_MALFORMED_RESPONSE", "App Server did not return a valid thread identifier");
  }
  if (started.model !== thread.requestedModel && started.model !== canonicalModel) {
    throw new PluginError("MODEL_UNAVAILABLE", "Codex selected a model other than the requested model",
      { details: { requestedModel: thread.requestedModel, effectiveModel: started.model } });
  }
  if (!samePath(canonicalDirectory(started.cwd), thread.cwd) ||
      !samePath(canonicalDirectory(started.thread.cwd), thread.cwd) || started.thread.ephemeral !== thread.ephemeral) {
    throw new PluginError("THREAD_WORKSPACE_MISMATCH", "Returned Codex thread does not match the requested workspace");
  }
  const policy = thread.policy;
  const expectedType = policy.sandbox === "read-only" ? "readOnly" : "workspaceWrite";
  const roots = started.sandbox?.type === "workspaceWrite" ? started.sandbox.writableRoots ?? [] : [];
  if (started.sandbox?.type !== expectedType || (started.sandbox?.networkAccess && !policy.networkAccess) ||
      !Array.isArray(roots) || roots.some(root => !containsPath(thread.cwd, canonicalDirectory(root))) ||
      !isApprovalPolicy(started.approvalPolicy) ||
      typeof started.approvalPolicy !== typeof policy.approvalPolicy ||
      !sameApprovalPolicy(stricterApproval(policy.approvalPolicy, started.approvalPolicy), started.approvalPolicy) ||
      (started.approvalsReviewer !== undefined && started.approvalsReviewer !== "user")) {
    throw new PluginError("POLICY_VIOLATION", "Codex did not apply the requested sandbox or approval restrictions");
  }
}

export class CodexRuntime {
  constructor(private readonly context: RuntimeContext) {}

  async execute(options: RuntimeOptions): Promise<RuntimeResult> {
    const cwd = canonicalDirectory(options.cwd);
    const workspaceRoot = canonicalDirectory(options.workspaceRoot);
    for (const value of Object.values(options.explicit ?? {})) if (typeof value === "string") assertSafeOption(value);
    const settings = this.context.config.resolve(workspaceRoot, options.explicit);
    const controller = new AbortController();
    const external = options.signal;
    const forwardAbort = () => controller.abort(external?.reason);
    external?.addEventListener("abort", forwardAbort, { once: true });
    if (external?.aborted) forwardAbort();
    const timer = setTimeout(() => controller.abort(new PluginError("TIMEOUT", "Codex turn exceeded the task deadline")), settings.timeoutSeconds * 1000);
    const signal = controller.signal;
    let client: AppServerClient | undefined;
    try {
      signal.throwIfAborted();
      options.onProgress?.({ phase: "starting", message: "Connecting to Codex App Server" });
      const opening = connectAppServer(cwd, this.context.broker, this.context.binary);
      void opening.then(late => { if (signal.aborted) void late.close(); }, () => {});
      client = await abortable(opening, signal);
      const active = client;
      const get = <T>(promise: Promise<T>) => abortable(promise, signal);
      const baseline = readBaseline(await get(active.request("config/read", { cwd, includeLayers: true })));
      const merged = this.context.config.resolve(workspaceRoot, options.explicit, baseline);
      const policy = resolvePolicy(baseline, merged, options.readOnly || !!options.reviewTarget);
      if (options.inheritedPolicy) {
        policy.approvalPolicy = stricterApproval(policy.approvalPolicy, options.inheritedPolicy.approvalPolicy);
        policy.networkAccess &&= options.inheritedPolicy.networkAccess;
      }
      const account = await get(active.request("account/read", { refreshToken: false }));
      checkAccount(account);
      const validation = await get(validateModel(active, merged.model, merged.reasoningEffort,
        { requiresOpenaiAuth: account.requiresOpenaiAuth, modelProvider: baseline.model_provider }));
      const params = {
        cwd, model: merged.model, sandbox: policy.sandbox, approvalPolicy: policy.approvalPolicy,
        approvalsReviewer: "user" as const,
        config: {
          model_reasoning_effort: merged.reasoningEffort,
          review_model: merged.model,
          "sandbox_workspace_write.network_access": policy.networkAccess,
          "sandbox_workspace_write.writable_roots": [],
          "sandbox_workspace_write.exclude_tmpdir_env_var": true,
          "sandbox_workspace_write.exclude_slash_tmp": true,
        },
      };
      if (options.threadId) {
        const current = await get(active.request("thread/read", { threadId: options.threadId, includeTurns: false })).catch(error => {
          if (/not found|no rollout|unknown thread/i.test(error instanceof Error ? error.message : "")) {
            throw new PluginError("THREAD_NOT_FOUND", "Codex could not read the persistent thread");
          }
          throw error;
        });
        if (current.thread?.ephemeral || current.thread?.id !== options.threadId ||
            !samePath(canonicalDirectory(current.thread.cwd), cwd)) {
          throw new PluginError("THREAD_WORKSPACE_MISMATCH", "Codex thread is bound to a different workspace");
        }
        if (current.thread.status?.type === "active") {
          throw new PluginError("INVALID_ARGUMENTS", "The Codex thread already has an active turn");
        }
      }
      const thread = {
        workspaceRoot, cwd, ephemeral: options.ephemeral ?? false,
        requestedModel: merged.model, reasoningEffort: merged.reasoningEffort, policy,
      };
      const started = options.threadId
        ? await get(active.request("thread/resume", { ...params, threadId: options.threadId, excludeTurns: true }))
        : await get(active.request("thread/start", { ...params, serviceName: SERVICE_NAME, ephemeral: thread.ephemeral }));
      verifyThread(started, thread, validation.model?.model);
      const bound: RuntimeThread = { ...thread, threadId: started.thread.id, effectiveModel: started.model };
      options.onThread?.(bound);
      if (!options.threadId && !bound.ephemeral && options.threadName) {
        await get(active.request("thread/name/set", { threadId: bound.threadId, name: bounded(options.threadName, 128) ?? "Antigravity task" }));
      }
      return { thread: bound, modelValidation: validation.status, ...await captureTurn(active, bound, options, signal) };
    } catch (error) {
      throw runtimeError(error);
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", forwardAbort);
      await client?.close();
    }
  }
}

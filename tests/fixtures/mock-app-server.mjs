import fs from "node:fs";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import process from "node:process";

const arg = process.argv[2];
if (arg === "--version") {
  console.log("codex-cli 0.172.0");
  process.exit(0);
}
if (process.argv[3] === "--help") {
  console.log("Usage: codex app-server");
  process.exit(0);
}
const cwd = process.cwd();
const scenario = process.env.CODEX_AGY_MOCK_SCENARIO ?? "";
const trace = process.env.CODEX_AGY_MOCK_TRACE;
const traceEvent = value => { if (trace) fs.appendFileSync(trace, JSON.stringify(value) + "\n"); };
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const emit = (method, params) => send({ method, params });
const result = (id, body) => send({ id, result: body });
const failure = (id, code, message) => send({ id, error: { code, message } });

const threads = new Map();
const turns = new Map();
const approved = new Map();

function readThread(id) {
  const saved = threads.get(id);
  if (saved || !process.env.CODEX_AGY_MOCK_THREADS) return saved;
  try { return JSON.parse(fs.readFileSync(process.env.CODEX_AGY_MOCK_THREADS + "/" + id + ".json", "utf8")); }
  catch { return undefined; }
}

function finish(threadId, turnId, status = "completed", text = "Fixture completed") {
  if (!turns.delete(turnId)) return;
  if (status === "completed") {
    emit("item/completed", { threadId, turnId, item: { id: randomUUID(), type: "agentMessage", text, phase: "final_answer" } });
    emit("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: {
      total: { totalTokens: 42, inputTokens: 34, outputTokens: 8 }, last: { totalTokens: 42 }, modelContextWindow: null,
    } });
    emit("turn/diff/updated", { threadId, turnId, diff: "diff --git a/fixture.txt b/fixture.txt\n" });
  }
  emit("turn/completed", { threadId, turn: { id: turnId, items: [], status, error: null } });
}

function startTurn(id, threadId, params, isReview) {
  if (!readThread(threadId)) return failure(id, -32602, "Thread not found");
  const turnId = randomUUID();
  const turn = { id: turnId, items: [], status: "inProgress", error: null };
  turns.set(turnId, threadId);
  result(id, isReview ? { turn, reviewThreadId: threadId } : { turn });
  emit("turn/started", { threadId, turn });
  const approval = scenario.startsWith("approval:") ? scenario.slice("approval:".length) : "";
  const prompt = params.input?.[0]?.text ?? "";
  if (approval) {
    approved.set("approval-" + turnId, turnId);
    send({ id: "approval-" + turnId, method: approval, params: { threadId, turnId, command: "fixture command", cwd } });
  } else if (scenario === "disconnect") {
    process.exit(18);
  } else if (["unauthorized", "modelNotFound", "rateLimitExceeded"].includes(scenario)) {
    turns.delete(turnId);
    emit("turn/completed", { threadId, turn: {
      id: turnId, status: "failed", items: [], error: { message: "Fixture turn failed", codexErrorInfo: scenario },
    } });
  } else if (scenario === "collab") {
    const child = randomUUID();
    const childTurn = randomUUID();
    const collab = { id: randomUUID(), type: "collabAgentToolCall", receiverThreadIds: [child] };
    emit("item/started", { threadId, turnId, item: collab });
    emit("turn/started", { threadId: child, turn: { id: childTurn } });
    emit("item/completed", { threadId, turnId, item: { id: randomUUID(), type: "agentMessage", text: "Collaboration complete", phase: "final_answer" } });
    setTimeout(() => {
      emit("item/completed", { threadId, turnId, item: collab });
      emit("turn/completed", { threadId: child, turn: { id: childTurn, status: "completed" } });
    }, 350);
  } else if (scenario !== "slow" && !prompt.includes("fixture:slow")) {
    if (prompt.includes("fixture:parallel") && params.sandboxPolicy?.type === "workspaceWrite") {
      fs.writeFileSync(cwd + "/fixture.txt", "worktree fixture");
      emit("item/completed", { threadId, turnId, item: {
        id: randomUUID(), type: "fileChange", status: "completed", changes: [{ path: "fixture.txt", kind: { type: "update" } }],
      } });
    }
    const reply = scenario === "hookBlock" ? "BLOCK: diagnostic worker text" :
      scenario === "hookAllow" ? "ALLOW: no fixture issue" :
      scenario === "invalidReview" && params.outputSchema ? "fixture invalid JSON" : params.outputSchema
      ? JSON.stringify({ verdict: "approve", summary: "Fixture review complete", findings: [], next_steps: [] })
      : "Fixture completed";
    if (scenario === "reroute") emit("model/rerouted", { threadId, turnId, fromModel: "gpt-6.2-sol", toModel: "fixture-model", reason: "fixture" });
    setTimeout(() => finish(threadId, turnId, "completed", reply), prompt.includes("fixture:parallel") ? 1600 : 15);
  }
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  const { id, method, params = {}, result: body, error } = JSON.parse(line);
  if (id === undefined) continue;
  if (!method) {
    const turnId = approved.get(id);
    if (turnId) {
      approved.delete(id);
      traceEvent({ approvalReply: body ?? error });
      finish(turns.get(turnId), turnId, "interrupted");
    }
    continue;
  }
  traceEvent({ method, params });
  if (method === "initialize") {
    if (scenario === "malformed") { process.stdout.write("broken\n"); continue; }
    if (scenario === "oversized") { process.stdout.write("a".repeat(16 * 1024 * 1024 + 1) + "\n"); continue; }
    result(id, { userAgent: "fixture", platformFamily: process.platform, platformOs: process.platform });
  } else if (method === "account/read") {
    result(id, { account: scenario === "auth" || scenario === "custom" ? null : { type: scenario === "apiKey" ? "apiKey" : "chatgpt" }, requiresOpenaiAuth: scenario !== "custom" });
  } else if (method === "config/read") {
    result(id, { config: { sandbox_mode: scenario === "readonly" ? "read-only" : "workspace-write", approval_policy: scenario === "strict" ? "on-request" : null,
      model: null, model_reasoning_effort: null, sandbox_workspace_write: { network_access: false } },
      layers: scenario === "untrusted" ? [{ name: { type: "project" }, disabledReason: "untrusted" }] : [] });
  } else if (method === "model/list") {
    const model = scenario === "unsupported" ? "different-model" : "gpt-6.2-sol";
    result(id, { data: scenario === "custom" ? [] : [{ id: model, model, hidden: false, defaultReasoningEffort: "low",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map(reasoningEffort => ({ reasoningEffort })) }], nextCursor: null });
  } else if (method === "windowsSandbox/readiness") {
    result(id, { status: "ready" });
  } else if (method === "thread/start" || method === "thread/resume") {
    const thread = method === "thread/start" ? {
      id: randomUUID(), cwd: params.cwd, ephemeral: params.ephemeral, status: { type: "idle" },
    } : readThread(params.threadId);
    if (!thread) { failure(id, -32602, "Thread not found"); continue; }
    threads.set(thread.id, thread);
    if (!thread.ephemeral && process.env.CODEX_AGY_MOCK_THREADS) {
      fs.writeFileSync(process.env.CODEX_AGY_MOCK_THREADS + "/" + thread.id + ".json", JSON.stringify(thread));
    }
    result(id, { thread, cwd: thread.cwd, model: params.model, modelProvider: "fixture",
      approvalPolicy: params.approvalPolicy,
      sandbox: { type: params.sandbox === "workspace-write" ? "workspaceWrite" : "readOnly", networkAccess: false },
      reasoningEffort: null });
  } else if (method === "thread/read") {
    const thread = readThread(params.threadId);
    if (thread) result(id, { thread });
    else failure(id, -32602, "Thread not found");
  } else if (method === "thread/name/set") {
    result(id, {});
  } else if (method === "thread/list") {
    result(id, { data: [...threads.values()], nextCursor: null });
  } else if (method === "turn/start" || method === "review/start") {
    startTurn(id, params.threadId, params, method === "review/start");
  } else if (method === "turn/interrupt") {
    if (!turns.has(params.turnId)) { failure(id, -32602, "Turn not found"); continue; }
    result(id, {});
    finish(params.threadId, params.turnId, "interrupted");
  } else {
    failure(id, -32601, "Unsupported fixture method");
  }
}

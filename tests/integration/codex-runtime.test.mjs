import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ConfigManager } from "../../dist/lib/config/index.js";
import { CodexRuntime } from "../../dist/lib/runtime/index.js";
import { PluginError } from "../../dist/lib/security/index.js";

const binary = { executable: process.execPath, kind: "npm",
  prefix: [fileURLToPath(new URL("../fixtures/mock-app-server.mjs", import.meta.url))] };
function fixture(t, scenario = "", transform) {
  const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ca-")));
  const trace = path.join(cwd, "trace.jsonl");
  const config = new ConfigManager(cwd);
  let executable = binary;
  if (transform) {
    const customMock = path.join(cwd, "mock.mjs");
    fs.writeFileSync(customMock, transform(fs.readFileSync(binary.prefix[0], "utf8")));
    executable = { ...binary, prefix: [customMock] };
  }
  const runtime = new CodexRuntime({ config, binary: executable });
  process.env.CODEX_AGY_MOCK_SCENARIO = scenario;
  process.env.CODEX_AGY_MOCK_TRACE = trace;
  process.env.CODEX_AGY_MOCK_THREADS = cwd;
  t.after(() => {
    delete process.env.CODEX_AGY_MOCK_TRACE;
    delete process.env.CODEX_AGY_MOCK_THREADS;
    delete process.env.CODEX_AGY_MOCK_SCENARIO;
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  return {
    run: options => runtime.execute({ cwd, workspaceRoot: cwd, prompt: "fixture task", ...options }),
    trace: () => fs.readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse),
  };
}

test("turns persist and resume without weakening approvals", async t => {
  const { run, trace } = fixture(t, "strict");
  const first = await run({ explicit: { reasoningEffort: "ultra", approvalPolicy: "never" }, threadName: "Fixture task" });
  assert.equal(first.thread.requestedModel, "gpt-6.2-sol");
  assert.equal(first.thread.policy.approvalPolicy, "on-request");
  assert.equal(first.output.finalResponse, "Fixture completed");
  assert.equal(first.output.tokenUsage.total.totalTokens, 42);
  assert.match(first.output.turnDiff, /^diff --git/);
  const resumed = await run({ threadId: first.thread.threadId });
  assert.equal(resumed.thread.threadId, first.thread.threadId);
  assert.ok(trace().find(event => event.method === "thread/resume").params.excludeTurns);
  const start = trace().find(event => event.method === "turn/start");
  assert.equal(start.params.sandboxPolicy.type, "readOnly");
  assert.equal(start.params.sandboxPolicy.networkAccess, false);
});

test("reports provider reroutes and drains subagent work before inferring completion", async t => {
  const { run } = fixture(t, "reroute");
  assert.equal((await run()).output.modelRerouted.toModel, "fixture-model");
  process.env.CODEX_AGY_MOCK_SCENARIO = "collab";
  const start = performance.now();
  const collab = await run();
  assert.equal(collab.output.finalResponse, "Collaboration complete");
  assert.equal(collab.output.completionInferred, true);
  assert.equal(collab.output.tokenUsage, null);
  assert.ok(performance.now() - start >= 575);
});

test("turn cancel is routed to its owner and approval is reported", async t => {
  const { run, trace } = fixture(t, "approval:item/fileChange/requestApproval");
  const approval = await run();
  assert.equal(approval.status, "awaiting_approval");
  assert.deepEqual(trace().find(event => event.approvalReply).approvalReply, { decision: "cancel" });
  process.env.CODEX_AGY_MOCK_SCENARIO = "slow";
  const abort = new AbortController();
  await assert.rejects(run({
    signal: abort.signal, onProgress: progress => {
      if (progress.turnId) abort.abort(new PluginError("TIMEOUT", "fixture deadline"));
    },
  }), { code: "TIMEOUT" });
  assert.ok(trace().some(event => event.method === "turn/interrupt"));
});

test("maps provider errors and denies sandbox elevation", async t => {
  const { run } = fixture(t);
  for (const [scenario, code, retryable] of [
    ["unauthorized", "AUTH_REQUIRED", false], ["modelNotFound", "MODEL_UNAVAILABLE", false],
    ["rateLimitExceeded", "INTERNAL_ERROR", true],
  ]) {
    process.env.CODEX_AGY_MOCK_SCENARIO = scenario;
    await assert.rejects(run(), { code, retryable });
  }
  process.env.CODEX_AGY_MOCK_SCENARIO = "readonly";
  await assert.rejects(run({ explicit: { sandbox: "workspace-write" } }), { code: "POLICY_VIOLATION" });
});

test("thread verification accepts equivalent granular policies in a different wire key order", async t => {
  const granular = { granular: { sandbox_approval: false, rules: true, skill_approval: false, request_permissions: true, mcp_elicitations: false } };
  const { run } = fixture(t, "", source => source
    .replace('scenario === "strict" ? "on-request" : null', JSON.stringify(granular))
    .replace("approvalPolicy: params.approvalPolicy,", `approvalPolicy: { granular: Object.fromEntries(Object.entries(params.approvalPolicy.granular).reverse()) },`));
  assert.deepEqual((await run()).thread.policy.approvalPolicy, granular);
  await assert.rejects(run({ explicit: { approvalPolicy: "untrusted" } }), { code: "POLICY_VIOLATION" });
});

test("an authoritative completed turn wins when its owner's interrupt RPC rejects", async t => {
  const { run, trace } = fixture(t, "slow", source => source.replace(
    'result(id, {});\n    finish(params.threadId, params.turnId, "interrupted");',
    'finish(params.threadId, params.turnId, "completed", "Authoritative final response");\n    failure(id, -32602, "Turn already complete");',
  ));
  const abort = new AbortController();
  const outcome = await run({ signal: abort.signal, onProgress: progress => {
    if (progress.turnId) abort.abort(new PluginError("TIMEOUT", "fixture race"));
  } });
  assert.ok(trace().some(event => event.method === "turn/interrupt"));
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.output.finalResponse, "Authoritative final response");
  assert.equal(outcome.output.interruptAcknowledged, false);
});

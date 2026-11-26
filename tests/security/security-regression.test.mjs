import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ConfigManager } from "../../dist/lib/config/index.js";
import { CodexRuntime } from "../../dist/lib/runtime/index.js";
import { shutdownIdleBroker } from "../../dist/lib/app-server/index.js";
import { SecretRedactor } from "../../dist/lib/security/index.js";

const launch = name => fileURLToPath(new URL("../../scripts/" + name + ".mjs", import.meta.url));
const mock = fileURLToPath(new URL("../fixtures/mock-app-server.mjs", import.meta.url));

test("unsafe settings and flags are blocked before the App Server opens", async t => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ca-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = new ConfigManager(dir);
  const runtime = new CodexRuntime({ config });
  for (const bad of ["danger-full-access", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--approve-for-me"]) {
    assert.throws(() => config.update({ sandbox: bad }), { code: "POLICY_VIOLATION" });
    await assert.rejects(runtime.execute({ workspaceRoot: dir, cwd: dir, prompt: "Fixture", explicit: { sandbox: bad } }),
      { code: "POLICY_VIOLATION" });
  }
});

test("MCP rejects nonlocal scope and returns an approval pause without leaking user authority", async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ca-")));
  const [cwd,dataRoot,outside] = ["w","d","outside"].map(name => {
    const next = path.join(dir,name); fs.mkdirSync(next); return next;
  });
  fs.symlinkSync(outside, path.join(cwd, "escape"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd, shell: false }).status, 0);
  const config = new ConfigManager(dataRoot);
  const trace = path.join(dir,"trace");
  const env = { ...process.env, CODEX_BIN: mock, CODEX_PLUGIN_AGY_DATA_DIR: dataRoot,
    CODEX_AGY_MOCK_SCENARIO: "approval:item/commandExecution/requestApproval", CODEX_AGY_MOCK_TRACE: trace };
  delete env.PLUGIN_ROOT;
  const client = new Client({ name: "regression", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [launch("mcp-server")], cwd, env }));
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
  try {
    for (const tool of ["codex_delegate", "codex_resume"]) {
      assert.equal((await call(tool, { task: "Fixture", thread_id: "unknown", sandbox: "danger-full-access" })).error.code,
        "INVALID_ARGUMENTS");
    }
    assert.equal((await call("codex_delegate", { task: "Fixture", cwd: outside })).error.code, "PATH_OUTSIDE_WORKSPACE");
    assert.equal((await call("codex_delegate", { task: "Fixture", cwd: "escape" })).error.code, "SYMLINK_ESCAPE");
    assert.equal((await call("codex_delegate", { task: "Fixture", allowed_paths: ["escape/file"] })).error.code, "SYMLINK_ESCAPE");
    assert.equal((await call("codex_review", { scope: "staged", paths: ["escape/file"] })).error.code, "SYMLINK_ESCAPE");
    assert.equal((await call("codex_transfer", { objective: "Fixture", summary: "Context", relevant_files: ["../outside/file"] })).error.code,
      "PATH_OUTSIDE_WORKSPACE");
    assert.equal((await call("codex_review", { base: "--upload-pack=test" })).error.code, "INVALID_ARGUMENTS");
    assert.equal((await call("codex_resume", { task: "Fixture", thread_id: "foreign-thread" })).error.code,
      "THREAD_WORKSPACE_MISMATCH");

    const fakeSecret = "sk-proj-" + "A".repeat(28);
    const paused = await call("codex_delegate", { task: "Fixture " + fakeSecret, approval_policy: "on-request" });
    assert.equal(paused.pluginMeta.state, "awaiting_approval");
    assert.match(paused.pluginMeta.resumeCommand, /^codex resume [a-z0-9-]+$/);
    assert.equal(paused.workerOutput, null);
    assert.equal(paused.error.code, "APPROVAL_REQUIRED");
    const wire = fs.readFileSync(trace, "utf8");
    assert.match(wire, /"approvalReply":\{"decision":"cancel"\}/);
    const job = path.join(config.workspaceDirectory(cwd), "jobs", paused.pluginMeta.jobId + ".json");
    const persisted = fs.readFileSync(job, "utf8");
    assert.ok(!persisted.includes(fakeSecret));
    assert.match(persisted, /REDACTED:OPENAI_KEY/);
    assert.ok(!wire.includes(fakeSecret));
  } finally {
    await client.close();
    await delay(200);
    await shutdownIdleBroker({ dataRoot, script: launch("app-server-broker") }, cwd);
    await delay(200);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("redaction protects serialized envelopes, headers, and assigned secret-valued fields", () => {
  const fixture = "generic-fixture-token";
  const redactor = new SecretRedactor({ TEST_SECRET: fixture });
  const sanitized = redactor.deep({ nested: [
    { "authorization": "Bearer fixture-value", "refresh_token": "fixture-refresh" },
    "sample " + fixture, "-----BEGIN PRIVATE KEY-----\nfixture",
  ] });
  assert.doesNotMatch(JSON.stringify(sanitized), /fixture-value|fixture-refresh|generic-fixture-token|BEGIN PRIVATE KEY/);
  assert.match(JSON.stringify(sanitized), /REDACTED:AUTH_HEADER/);
});

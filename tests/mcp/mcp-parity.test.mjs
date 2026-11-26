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
import { brokerHealth, readBrokerRecord, shutdownIdleBroker } from "../../dist/lib/app-server/index.js";

test("MCP exposes review, detached structured review, handoff and bound resume", async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ca-")));
  const cwd = path.join(root, "w");
  const dataRoot = path.join(root, "d");
  fs.mkdirSync(cwd); fs.mkdirSync(dataRoot);
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd, shell: false }).status, 0);
  fs.writeFileSync(path.join(cwd, "fixture.txt"), "fixture\n");
  const commit = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--allow-empty", "-m", "initial"], { cwd, shell: false });
  assert.equal(commit.status, 0, commit.stderr.toString());
  const script = name => fileURLToPath(new URL("../../scripts/" + name + ".mjs", import.meta.url));
  const mock = fileURLToPath(new URL("../fixtures/mock-app-server.mjs", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [script("mcp-server")], cwd,
    env: { ...process.env, CODEX_BIN: mock, CODEX_PLUGIN_AGY_DATA_DIR: dataRoot, CODEX_AGY_MOCK_THREADS: root },
  });
  const client = new Client({ name: "fixture", version: "1" });
  await client.connect(transport);
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
  let worktreePath;
  try {
    assert.equal((await client.listTools()).tools.length, 10);
    assert.equal((await call("codex_review", { scope: "uncommitted" })).pluginMeta.sandbox, "read-only");
    const background = await call("codex_adversarial_review", { scope: "uncommitted", background: true });
    assert.equal(background.pluginMeta.state, "queued");
    const id = background.pluginMeta.jobId;
    let result = await call("codex_result", { job_id: id });
    for (let n = 0; n < 40 && result.error?.code === "JOB_NOT_FINISHED"; n++) {
      await delay(75);
      result = await call("codex_result", { job_id: id });
    }
    assert.equal(result.workerOutput.structuredReview.verdict, "approve", JSON.stringify(result.error));
    const handoff = await call("codex_transfer", { objective: "Fixture", summary: "Continue", relevant_files: ["fixture.txt"] });
    assert.match(handoff.pluginMeta.resumeCommand, /^codex resume /);
    const resumed = await call("codex_resume", { thread_id: handoff.pluginMeta.threadId, task: "Follow up" });
    assert.equal(resumed.pluginMeta.threadId, handoff.pluginMeta.threadId);
    assert.equal((await call("codex_resume", { thread_id: "unbound", task: "Follow up" })).error.code, "THREAD_WORKSPACE_MISMATCH");
    const isolated = await call("codex_delegate", { task: "Fixture worktree", use_worktree: true });
    worktreePath = isolated.pluginMeta.worktreePath;
    assert.ok(worktreePath, JSON.stringify(isolated.error));
    const turn = await call("codex_resume", { thread_id: isolated.pluginMeta.threadId, task: "Follow up in the same worktree" });
    assert.equal(turn.pluginMeta.threadId, isolated.pluginMeta.threadId);
    assert.equal(turn.pluginMeta.effectiveCwd, worktreePath);
    const brokerOptions = { dataRoot, script: script("app-server-broker") };
    for (let n = 0; n < 60 && (await brokerHealth(brokerOptions, worktreePath))?.busy; n++) await delay(25);
    assert.ok(readBrokerRecord(dataRoot, worktreePath));
    await client.close();
    for (let n = 0; n < 60 && readBrokerRecord(dataRoot, worktreePath); n++) await delay(25);
    assert.equal(readBrokerRecord(dataRoot, worktreePath), null);
  } finally {
    await client.close();
    await delay(250);
    await shutdownIdleBroker({ dataRoot, script: script("app-server-broker") }, cwd);
    if (worktreePath) await shutdownIdleBroker({ dataRoot, script: script("app-server-broker") }, worktreePath);
    await delay(200);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

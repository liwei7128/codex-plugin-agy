import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { brokerHealth, probeProcessIdentityAsync, readBrokerRecord, shutdownIdleBroker } from "../../dist/lib/app-server/index.js";
import { JobManager } from "../../dist/lib/jobs/index.js";
import { ConfigManager } from "../../dist/lib/config/index.js";

const server = fileURLToPath(new URL("../../scripts/mcp-server.mjs", import.meta.url));
const broker = fileURLToPath(new URL("../../scripts/app-server-broker.mjs", import.meta.url));
const mock = fileURLToPath(new URL("../fixtures/mock-app-server.mjs", import.meta.url));

async function fixture(extraEnv = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ca-")));
  for (const name of ["w", "d", "plugin"]) fs.mkdirSync(path.join(root, name));
  const cwd = path.join(root, "w");
  const data = path.join(root, "d");
  const work = path.join(root, "plugin");
  const env = { ...process.env, PLUGIN_ROOT: work, CODEX_PLUGIN_AGY_DATA_DIR: data, CODEX_BIN: mock, ...extraEnv };
  const transport = new StdioClientTransport({ command: process.execPath, args: [server], cwd: work, env, stderr: "pipe" });
  const client = new Client({ name: "fixture", version: "1.0.0" }, { capabilities: { roots: { listChanged: true } } });
  client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [{ uri: pathToFileURL(cwd).href }] }));
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text));
    return result.structuredContent;
  };
  return {
    client, transport, call, root, cwd, data, env, close: async () => {
      await client.close();
      await delay(100);
      await shutdownIdleBroker({ dataRoot: data, script: broker }, cwd);
      await delay(200);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

test("stdio API discovers tools and runs the core job lifecycle inside MCP roots", async () => {
  const fixtureContext = await fixture();
  const { client, call, cwd, root } = fixtureContext;
  try {
    const { tools } = await client.listTools();
    for (const tool of ["codex_setup","codex_delegate","codex_status","codex_result","codex_cancel","codex_list_jobs"]) {
      assert.ok(tools.some(entry => entry.name === tool), tool);
    }
    assert.equal((await call("codex_setup")).pluginMeta.readiness.ready, true);
    const completed = await call("codex_delegate", { task: "Fixture work" });
    assert.equal(completed.pluginMeta.effectiveCwd, cwd);
    assert.equal(completed.workerOutput.finalResponse, "Fixture completed");
    const details = await call("codex_result", {
      job_id: completed.pluginMeta.jobId, include_diff: "patch", include_logs: true,
    });
    assert.match(details.workerOutput.gitDiffPatch, /^diff --git/);
    assert.ok(details.pluginMeta.logsChunk);
    assert.equal((await call("codex_delegate", { cwd: root, task: "External fixture" })).error.code, "PATH_OUTSIDE_WORKSPACE");
    for (const args of [{}, { task: "Bad", sandbox: "danger-full-access" }, { task: "Bad", fake: true }]) {
      assert.equal((await call("codex_delegate", args)).error.code, "INVALID_ARGUMENTS");
    }
    assert.equal((await call("codex_delegate", { task: "Model check", model: "missing" })).error.code, "MODEL_UNAVAILABLE");
    const background = await call("codex_delegate", { task: "fixture:slow", background: true });
    assert.equal(background.pluginMeta.state, "queued");
    assert.equal(background.pluginMeta.recommendedPollIntervalMs, 5000);
    const id = background.pluginMeta.jobId;
    const inProgress = await call("codex_status", { job_id: id });
    assert.ok(["queued", "starting", "running"].includes(inProgress.pluginMeta.state));
    assert.equal((await call("codex_result", { job_id: id })).error.code, "JOB_NOT_FINISHED");
    assert.equal((await call("codex_cancel", { job_id: id })).pluginMeta.state, "cancelled");
    const page = (await call("codex_list_jobs", { limit: 1 })).pluginMeta;
    assert.equal(page.jobs.length, 1);
    assert.ok(page.nextCursor);
    assert.notEqual(page.jobs[0].jobId, (await call("codex_list_jobs", { cursor: page.nextCursor })).pluginMeta.jobs[0].jobId);
  } finally {
    await fixtureContext.close();
  }
});

async function waitFor(predicate) {
  const deadline = Date.now() + 6000;
  do {
    const value = await predicate();
    if (value) return value;
    await delay(30);
  } while (Date.now() < deadline);
  assert.fail("Condition timed out");
}

test("MCP EOF shuts down the idle broker automatically", async () => {
  const context = await fixture();
  const options = { dataRoot: context.data, script: broker };
  try {
    const job = await context.call("codex_delegate", { task: "fixture for idle shutdown" });
    assert.equal(job.pluginMeta.state, "completed");
    const record = readBrokerRecord(context.data, context.cwd);
    assert.ok(record);
    await waitFor(async () => (await brokerHealth(options, context.cwd))?.busy === false);
    await context.client.close();
    await waitFor(() => readBrokerRecord(context.data, context.cwd) === null);
    await waitFor(async () => await probeProcessIdentityAsync(record.identity) === "dead");
  } finally {
    await context.close();
  }
});

test("MCP SIGTERM closes stdio and shuts down the idle broker", { skip: process.platform === "win32" }, async () => {
  const context = await fixture();
  const options = { dataRoot: context.data, script: broker };
  try {
    const job = await context.call("codex_delegate", { task: "fixture for SIGTERM shutdown" });
    assert.equal(job.pluginMeta.state, "completed");
    const record = readBrokerRecord(context.data, context.cwd);
    assert.ok(record);
    const closed = new Promise(resolve => { context.client.onclose = resolve; });
    await waitFor(async () => (await brokerHealth(options, context.cwd))?.busy === false);
    process.kill(context.transport.pid, "SIGTERM");
    await closed;
    assert.equal(readBrokerRecord(context.data, context.cwd), null);
  } finally {
    await context.close();
  }
});

test("MCP EOF leaves a leased broker and detached job active", async () => {
  const context = await fixture();
  const worker = fileURLToPath(new URL("../../scripts/task-worker.mjs", import.meta.url));
  const manager = new JobManager(new ConfigManager(context.data), context.cwd, worker);
  const options = { dataRoot: context.data, script: broker };
  let id;
  try {
    id = (await context.call("codex_delegate", { task: "fixture:slow", background: true })).pluginMeta.jobId;
    await waitFor(() => manager.store.get(id).turnId);
    await context.client.close();
    assert.equal(manager.store.get(id).state, "running");
    assert.equal((await brokerHealth(options, context.cwd)).busy, true);
  } finally {
    if (id && manager.store.get(id)?.state === "running") await manager.cancel(id);
    await context.close();
  }
});

test("setup reports that Codex is missing", async () => {
  const context = await fixture({ CODEX_BIN: path.join(os.tmpdir(), "agy-fixture-does-not-exist", "codex") });
  try {
    const result = await context.call("codex_setup");
    assert.equal(result.error.code, "CODEX_NOT_INSTALLED");
    assert.equal(result.pluginMeta.readiness.ready, false);
  } finally {
    await context.close();
  }
});

test("stdio contains only JSON-RPC even for invalid tool calls", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "ca-"));
  const child = spawn(process.execPath, [server], {
    shell: false, cwd: data, env: { ...process.env, CODEX_PLUGIN_AGY_DATA_DIR: data }, windowsHide: true,
  });
  const text = [];
  child.stdout.on("data", chunk => text.push(chunk));
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  send({ id: 1, method: "initialize", params: { clientInfo: { name: "fixture", version: "1" },
    protocolVersion: "2025-11-25", capabilities: {} } });
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/call", params: { name: "codex_delegate", arguments: {} } });
  for (let n = 0; n < 100 && !Buffer.concat(text).toString().includes('"id":2'); n++) await delay(20);
  child.stdin.end();
  await once(child, "close");
  fs.rmSync(data, { recursive: true, force: true });
  const lines = Buffer.concat(text).toString("utf8").trim().split("\n").map(JSON.parse);
  assert.ok(lines.length >= 2);
  assert.ok(lines.every(line => line.jsonrpc === "2.0"));
  assert.equal(lines.find(line => line.id === 2).result.structuredContent.error.code, "INVALID_ARGUMENTS");
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  brokerHealth, captureProcessIdentity, connectAppServer, connectBrokerSocket, connectDirect, probeProcessIdentityAsync,
  readBrokerRecord, shutdownIdleBroker, terminateVerifiedProcessTree, verifyProcessIdentity,
} from "../../dist/lib/app-server/index.js";
import { brokerDirectory, endpointPath, makeBrokerEndpoint } from "../../dist/lib/app-server/broker-endpoint.js";

const mock = fileURLToPath(new URL("../fixtures/mock-app-server.mjs", import.meta.url));
const script = fileURLToPath(new URL("../../scripts/app-server-broker.mjs", import.meta.url));
const binary = { kind: "npm", executable: process.execPath, prefix: [mock] };

function temp(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ca-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function until(predicate) {
  const deadline = Date.now() + 3500;
  do {
    if (await predicate()) return;
    await delay(50);
  } while (Date.now() < deadline);
  assert.fail("Expected broker condition did not occur");
}

async function waitForBrokerExit(options, cwd, identity) {
  await until(async () => readBrokerRecord(options.dataRoot, cwd) === null &&
    await probeProcessIdentityAsync(identity) === "dead");
}

test("direct initializes and routes correlated RPCs", async t => {
  const client = await connectDirect(temp(t), binary);
  try {
    assert.equal(client.initialization.userAgent, "fixture");
    const [account, models] = await Promise.all([
      client.request("account/read", { refreshToken: false }), client.request("model/list", {}),
    ]);
    assert.equal(account.account.type, "chatgpt");
    assert.equal(models.data[0].model, "gpt-6.2-sol");
  } finally {
    await client.close();
  }
});

test("broker authenticates before forwarding, falls back when busy, and expires", async t => {
  const cwd = temp(t);
  const dataRoot = path.join(cwd, "d");
  fs.mkdirSync(dataRoot);
  const broker = { dataRoot, script, idleMs: 1000 };
  const original = process.env.CODEX_BIN;
  process.env.CODEX_BIN = mock;
  t.after(() => {
    if (original === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = original;
  });
  const first = await connectAppServer(cwd, broker);
  const record = readBrokerRecord(dataRoot, cwd);
  try {
    assert.equal(first.transport, "broker");
    assert.ok(record);
    assert.equal((await brokerHealth(broker, cwd)).busy, true);
    if (process.platform !== "win32") assert.equal(fs.statSync(endpointPath(record.endpoint)).mode & 0o777, 0o600);
    const bypass = net.connect(endpointPath(record.endpoint));
    await once(bypass, "connect");
    bypass.write('{"id":1,"method":"broker/health"}\n');
    await once(bypass, "close");
    await assert.rejects(connectBrokerSocket(record.endpoint, "f".repeat(64)), { code: "APP_SERVER_DISCONNECTED" });
    const second = await connectAppServer(cwd, broker);
    assert.equal(second.transport, "direct");
    await second.close();
    assert.equal(await shutdownIdleBroker(broker, cwd), false);
  } finally {
    await first.close();
  }
  await waitForBrokerExit(broker, cwd, record.identity);
  const recovered = await connectAppServer(cwd, broker);
  const replacement = readBrokerRecord(dataRoot, cwd);
  await recovered.close();
  assert.equal(recovered.transport, "broker");
  assert.ok(replacement);
  await until(() => shutdownIdleBroker(broker, cwd));
  await waitForBrokerExit(broker, cwd, replacement.identity);
});

test("reject malformed and oversized App Server lines", async t => {
  const cwd = temp(t);
  const previous = process.env.CODEX_AGY_MOCK_SCENARIO;
  try {
    for (const scenario of ["malformed", "oversized"]) {
      process.env.CODEX_AGY_MOCK_SCENARIO = scenario;
      await assert.rejects(connectDirect(cwd, binary), { code: "PROTOCOL_MALFORMED_RESPONSE" });
    }
  } finally {
    if (previous === undefined) delete process.env.CODEX_AGY_MOCK_SCENARIO;
    else process.env.CODEX_AGY_MOCK_SCENARIO = previous;
  }
});

test("a newly dead broker is replaced immediately and its Unix socket is pruned", async t => {
  const cwd = temp(t);
  const options = { dataRoot: cwd, script };
  const directory = brokerDirectory(cwd, cwd);
  const endpoint = makeBrokerEndpoint(directory);
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = mock;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
  });
  const marker = "a".repeat(32);
  const owner = spawn(process.execPath, ["-e", `require('node:net').createServer().listen(${JSON.stringify(endpointPath(endpoint))}, () => console.log('ready'));`, "--", marker],
    { windowsHide: true, shell: false });
  const closed = once(owner, "close");
  try {
    await once(owner.stdout, "data");
  } finally {
    owner.kill("SIGKILL");
    await closed;
  }
  const stale = captureProcessIdentity(owner.pid, marker);
  fs.writeFileSync(path.join(directory, "broker.json"), JSON.stringify({ endpoint, authToken: "b".repeat(64), identity: stale, cwd }));
  if (process.platform !== "win32") assert.ok(fs.lstatSync(endpointPath(endpoint)).isSocket());
  const client = await connectAppServer(cwd, options);
  const replacement = readBrokerRecord(cwd, cwd);
  try {
    assert.equal(client.transport, "broker");
    assert.ok(replacement);
    assert.notEqual(replacement.identity.markerToken, stale.markerToken);
    if (process.platform !== "win32") assert.equal(fs.existsSync(endpointPath(endpoint)), false);
  } finally {
    await client.close();
    await until(() => shutdownIdleBroker(options, cwd));
    if (replacement) await waitForBrokerExit(options, cwd, replacement.identity);
  }
});

test("all approval variants are rejected over the wire", async t => {
  const cwd = temp(t);
  const trace = path.join(cwd, "trace.jsonl");
  const modes = [
    ["item/commandExecution/requestApproval", { decision: "cancel" }],
    ["item/fileChange/requestApproval", { decision: "cancel" }],
    ["item/permissions/requestApproval", { permissions: {}, scope: "turn" }],
    ["execCommandApproval", { decision: "abort" }],
    ["applyPatchApproval", { decision: "abort" }],
    ["item/tool/requestUserInput", { code: -32601 }],
    ["mcpServer/elicitation/request", { code: -32601 }],
  ];
  try {
    process.env.CODEX_AGY_MOCK_TRACE = trace;
    for (const [index, [mode, expected]] of modes.entries()) {
      process.env.CODEX_AGY_MOCK_SCENARIO = "approval:" + mode;
      const client = await connectDirect(cwd, binary);
      try {
        const { thread } = await client.request("thread/start", { cwd, ephemeral: true, serviceName: "antigravity_codex_plugin",
          model: "gpt-6.2-sol", sandbox: "read-only", approvalPolicy: "on-request" });
        const approval = once(client, "approval");
        await client.request("turn/start", { threadId: thread.id, input: [] });
        assert.equal((await approval)[0].method, mode);
        await until(() => fs.readFileSync(trace, "utf8").split("\n").filter(line => line.includes("approvalReply")).length === index + 1);
        const last = fs.readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse).filter(event => event.approvalReply).at(-1);
        for (const [key, value] of Object.entries(expected)) assert.deepEqual(last.approvalReply[key], value);
      } finally {
        await client.close();
      }
    }
  } finally {
    delete process.env.CODEX_AGY_MOCK_SCENARIO;
    delete process.env.CODEX_AGY_MOCK_TRACE;
  }
});

test("mismatched process identities never trigger OS termination", () => {
  const wrong = captureProcessIdentity(process.pid, "a".repeat(32), Date.now() - 60_000);
  assert.equal(verifyProcessIdentity(wrong), false);
  assert.equal(terminateVerifiedProcessTree(wrong), false);
});

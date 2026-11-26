import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ConfigManager } from "../../dist/lib/config/index.js";
import { shutdownIdleBroker } from "../../dist/lib/app-server/index.js";
import { reviewGate } from "../../dist/lib/adapters/antigravity/review-gate.js";

const script = name => fileURLToPath(new URL("../../scripts/" + name + ".mjs", import.meta.url));

async function fixture(mode, run) {
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ca-")));
  const cwd = path.join(temp, "w");
  const dataRoot = path.join(temp, "d");
  fs.mkdirSync(cwd); fs.mkdirSync(dataRoot);
  const config = new ConfigManager(dataRoot);
  const mock = fileURLToPath(new URL("../fixtures/mock-app-server.mjs", import.meta.url));
  const env = { CODEX_BIN: mock, CODEX_AGY_MOCK_SCENARIO: mode, CODEX_PLUGIN_AGY_DATA_DIR: dataRoot };
  const git = (...args) => assert.equal(spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, shell: false }).status, 0);
  git("init", "--quiet");
  const edit = text => fs.writeFileSync(path.join(cwd, "file.txt"), text + "\n");
  edit("initial");
  git("add", "--", ".");
  git("commit", "-m", "initial");
  const payload = { conversationId: "fixture-conversation", cwd, workspacePaths: [cwd],
    lastUserInput: "Fixture prompt", terminationReason: "NO_TOOL_CALL", executionNum: 0, fullyIdle: true, continuationActive: false };
  const invoke = (event, overrides = {}, environment = {}) => {
    const call = spawnSync(process.execPath, [script("hooks"), event], { shell: false, cwd: process.cwd(),
      env: { ...process.env, ...env, ...environment }, encoding: "utf8", timeout: 15_000,
      input: JSON.stringify({ ...payload, hookEventName: event, ...overrides }) });
    assert.equal(call.status, 0, call.stderr);
    return JSON.parse(call.stdout);
  };
  try {
    await run({ cwd, config, payload, invoke, edit, env });
  } finally {
    await shutdownIdleBroker({ dataRoot, script: script("app-server-broker") }, cwd);
    await delay(200);
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
  }
}

test("native hook CLI allows default-disabled, recursive, and non-natural stops", async () => {
  await fixture("hookBlock", ({ cwd, config, invoke, edit }) => {
    assert.deepEqual(invoke("SessionStart"), {});
    edit("modified");
    assert.deepEqual(invoke("Stop"), {});
    config.update({ reviewGate: { enabled: true } }, cwd);
    assert.deepEqual(invoke("SessionStart"), {});
    edit("further");
    assert.deepEqual(invoke("Stop", { terminationReason: "ERROR" }), {});
    assert.deepEqual(invoke("Stop", {}, { CODEX_PLUGIN_AGY_IN_HOOK: "1" }), {});
    assert.deepEqual(invoke("Stop", { fullyIdle: false }), {});
  });
});

test("ALLOW stops; BLOCK continues with a trusted reference and the sequence caps retries", async () => {
  await fixture("hookAllow", ({ cwd, config, invoke, edit }) => {
    config.update({ reviewGate: { enabled: true } }, cwd);
    invoke("SessionStart");
    edit("allow change");
    assert.deepEqual(invoke("Stop"), {});
    assert.ok(fs.existsSync(path.join(config.workspaceDirectory(cwd), "jobs")));
  });
  await fixture("hookBlock", ({ cwd, config, invoke, edit }) => {
    config.update({ reviewGate: { enabled: true, maxRunsPerTurn: 2 } }, cwd);
    invoke("SessionStart");
    edit("first change");
    const first = invoke("Stop");
    assert.equal(first.decision, "continue");
    assert.match(first.reason, /codex_result/);
    assert.doesNotMatch(first.reason, /diagnostic worker text/);
    assert.deepEqual(invoke("Stop"), {});
    edit("second change");
    assert.equal(invoke("Stop", { executionNum: 1, continuationActive: false }).decision, "continue");
    edit("third change");
    assert.deepEqual(invoke("Stop", { executionNum: 2, continuationActive: false }), {});
    edit("new prompt edit");
    assert.equal(invoke("Stop", { lastUserInput: "New fixture prompt", executionNum: 3 }).decision, "continue");
    edit("duplicate replay edit");
    assert.deepEqual(invoke("Stop", { lastUserInput: "New fixture prompt", executionNum: 3 }), {});
  });
});

test("a bounded timeout allows Stop and cancels its own worker", async () => {
  await fixture("slow", async ({ cwd, config, payload, invoke, edit, env }) => {
    config.update({ reviewGate: { enabled: true } }, cwd);
    invoke("SessionStart");
    edit("timeout change");
    const previous = process.env.CODEX_BIN;
    process.env.CODEX_BIN = env.CODEX_BIN;
    process.env.CODEX_AGY_MOCK_SCENARIO = "slow";
    const warnings = [];
    try {
      const signal = AbortSignal.timeout(2000);
      assert.deepEqual(await reviewGate({ config, pluginRoot: process.cwd(), worker: script("task-worker"),
        warning: text => warnings.push(text) }, cwd, cwd, payload, signal), {});
      assert.match(warnings.join("\n"), /timed out or was cancelled/);
    } finally {
      if (previous === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = previous;
      delete process.env.CODEX_AGY_MOCK_SCENARIO;
    }
  });
});

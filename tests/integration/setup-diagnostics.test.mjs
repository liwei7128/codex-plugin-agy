import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ConfigManager } from "../../dist/lib/config/index.js";
import { runSetup } from "../../dist/lib/diagnostics/index.js";

test("setup separates CLI, auth, model, trust and broker evidence", async t => {
  const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ca-")));
  t.after(() => {
    delete process.env.CODEX_AGY_MOCK_SCENARIO;
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const config = new ConfigManager(cwd);
  const binary = { kind: "npm", executable: process.execPath,
    prefix: [fileURLToPath(new URL("../fixtures/mock-app-server.mjs", import.meta.url))] };
  const setup = async scenario => {
    process.env.CODEX_AGY_MOCK_SCENARIO = scenario;
    return runSetup({ config, binary }, cwd, cwd);
  };
  for (const [scenario, mode] of [["", "chatgpt"], ["apiKey", "apiKey"], ["custom", "custom_provider"]]) {
    const value = await setup(scenario);
    assert.equal(value.ready, true);
    assert.equal(value.checks.find(check => check.name === "auth").detail, mode);
    assert.equal(value.checks.find(check => check.name === "appServer").status, "ok");
    assert.match(value.checks.find(check => check.name === "broker").detail, /Cold/);
  }
  assert.equal((await setup("auth")).errors[0].code, "AUTH_REQUIRED");
  assert.equal((await setup("unsupported")).errors[0].code, "MODEL_UNAVAILABLE");
  assert.equal((await setup("untrusted")).checks.find(check => check.name === "projectTrust").detail.status, "untrusted");
});

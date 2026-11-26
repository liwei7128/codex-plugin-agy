import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ConfigManager } from "../../dist/lib/config/index.js";
import { CodexRuntime } from "../../dist/lib/runtime/index.js";
import { parseReviewOutput, prepareReview } from "../../dist/lib/runtime/review.js";
import { prepareHandoff } from "../../dist/lib/runtime/transfer.js";

test("all four native targets use inline read-only review and staged uses a scoped turn", async t => {
  const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ca-")));
  t.after(() => {
    delete process.env.CODEX_AGY_MOCK_TRACE;
    delete process.env.CODEX_AGY_MOCK_SCENARIO;
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const trace = path.join(cwd, "trace.jsonl");
  process.env.CODEX_AGY_MOCK_TRACE = trace;
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, shell: false });
    assert.equal(result.status, 0, String(result.stderr));
  };
  git("init", "--quiet");
  git("symbolic-ref", "HEAD", "refs/heads/main");
  fs.writeFileSync(path.join(cwd, "fixture.txt"), "fixture\n");
  git("add", "--", "fixture.txt");
  git("commit", "-m", "fixture");
  const runtime = new CodexRuntime({ config: new ConfigManager(cwd), binary: { executable: process.execPath, kind: "npm",
    prefix: [fileURLToPath(new URL("../fixtures/mock-app-server.mjs", import.meta.url))] } });
  const run = (options, ephemeral = true) => runtime.execute({ cwd, workspaceRoot: cwd, readOnly: true, ephemeral, ...options });
  const plan = (options, adversarial = false) => prepareReview(cwd, cwd, process.cwd(), options, adversarial);
  for (const scope of [{scope:"uncommitted"},{base:"main"},{commit:"HEAD"},{instructions:"Fixture custom"}]) {
    const result = await run(plan(scope));
    assert.equal(result.thread.policy.sandbox, "read-only");
    assert.equal(result.status, "completed");
  }
  await run(plan({scope:"staged", paths:["fixture.txt"]}));
  const review = await run(plan({scope:"uncommitted"}, true));
  assert.equal(parseReviewOutput(review.output.finalResponse).structuredReview.verdict, "approve");
  process.env.CODEX_AGY_MOCK_SCENARIO = "invalidReview";
  const invalid = await run(plan({scope:"uncommitted"}, true));
  assert.match(parseReviewOutput(invalid.output.finalResponse).parseError, /not valid JSON/);
  const transfer = await run(prepareHandoff(cwd, { objective: "Fixture handoff", summary: "Context", relevant_files: ["fixture.txt"] }), false);
  assert.equal(transfer.thread.ephemeral, false);
  assert.equal(transfer.thread.policy.sandbox, "read-only");
  const calls = fs.readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.filter(x => x.method === "review/start").map(x => x.params.target.type),
    ["uncommittedChanges", "baseBranch", "commit", "custom"]);
  assert.ok(calls.filter(x => x.method === "review/start").every(x => x.params.delivery === "inline"));
  assert.ok(calls.some(x => x.method === "turn/start" && x.params.input[0].text.includes("specified Git scope")));
});

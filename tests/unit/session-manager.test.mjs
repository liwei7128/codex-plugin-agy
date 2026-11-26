import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resumeCommand, SessionManager } from "../../dist/lib/sessions/index.js";

test("persistent sessions are bound to one canonical workspace and policy", t => {
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ca-")));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const first = path.join(temp, "first");
  const second = path.join(temp, "second");
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  const state = path.join(temp, "state");
  const session = new SessionManager(first, state);
  const binding = { threadId: "fixture-thread", workspaceRoot: first, cwd: first, ephemeral: false,
    policy: { sandbox: "read-only", approvalPolicy: "on-request", networkAccess: false } };
  session.bind(binding, "fixture-job");
  assert.equal(new SessionManager(first, state).require(binding.threadId).policy.approvalPolicy, "on-request");
  assert.throws(() => new SessionManager(second, state).require(binding.threadId), { code: "THREAD_WORKSPACE_MISMATCH" });
  assert.equal(resumeCommand(binding.threadId), "codex resume fixture-thread");
  session.bind({ ...binding, threadId: "ephemeral", ephemeral: true }, "fixture-job");
  assert.throws(() => session.require("ephemeral"), { code: "THREAD_NOT_FOUND" });
  assert.equal(resumeCommand("id; whoami"), null);
});

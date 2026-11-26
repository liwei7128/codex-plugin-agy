import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LockRegistry } from "../../dist/lib/workspace/index.js";

test("leases allow overlapping reads and isolate concurrent writes", t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ca-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const locks = new LockRegistry(base);
  const cwd = path.join(base, "w");
  const lease = (jobId, sandbox, target = cwd) => ({ jobId, sandbox, cwd: target, workspaceRoot: cwd,
    recordFile: path.join(base, jobId), reservedAtMs: Date.now(), limit: 2 });
  locks.reserve(lease("one", "read-only"), () => true);
  locks.reserve(lease("two", "read-only"), () => true);
  assert.throws(() => locks.reserve(lease("three", "read-only"), () => true), { code: "CONCURRENCY_LIMIT_REACHED" });
  locks.reserve(lease("three", "workspace-write"), () => false);
  assert.throws(() => locks.reserve(lease("four", "workspace-write", path.join(cwd, "nested")), () => true), { code: "WORKSPACE_WRITE_LOCKED" });
  locks.reserve(lease("four", "workspace-write", path.join(base, "other")), () => true);
  locks.release("three");
  locks.reserve(lease("five", "workspace-write", cwd), () => true);
});

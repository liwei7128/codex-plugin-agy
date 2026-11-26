import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ConfigManager } from "../../dist/lib/config/index.js";
import { captureProcessIdentity, probeProcessIdentityAsync, shutdownIdleBroker } from "../../dist/lib/app-server/index.js";
import { terminateVerifiedProcessTree, verifyProcessIdentity } from "../../dist/lib/runtime/index.js";
import { JobManager } from "../../dist/lib/jobs/index.js";
import { LockRegistry } from "../../dist/lib/workspace/index.js";

const worker = fileURLToPath(new URL("../../scripts/task-worker.mjs", import.meta.url));
const script = fileURLToPath(new URL("../../scripts/app-server-broker.mjs", import.meta.url));
const mock = fileURLToPath(new URL("../fixtures/mock-app-server.mjs", import.meta.url));

async function until(predicate, timeout = 7000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await predicate();
    if (value) return value;
    await delay(40);
  } while (Date.now() < deadline);
  assert.fail("Condition timed out");
}

async function scenario(t, mode, work) {
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ca-")));
  const cwd = path.join(temp, "w");
  const dataRoot = path.join(temp, "d");
  fs.mkdirSync(cwd);
  fs.mkdirSync(dataRoot);
  const trace = path.join(temp, "trace.jsonl");
  const env = { CODEX_BIN: mock, CODEX_AGY_MOCK_TRACE: trace, CODEX_AGY_MOCK_SCENARIO: mode, CODEX_AGY_MOCK_THREADS: temp };
  Object.assign(process.env, env);
  const manager = new JobManager(new ConfigManager(dataRoot), cwd, worker);
  try {
    await work({ manager, cwd, trace, dataRoot, start: (prompt, explicit) => manager.create({ kind: "delegate", cwd, prompt, explicit }) });
  } finally {
    for (const job of manager.list().filter(job => ["queued", "starting", "running", "cancelling"].includes(job.state))) {
      await manager.cancel(job.id);
    }
    try { await until(() => shutdownIdleBroker({ dataRoot, script }, cwd), 3000); } catch {}
    for (const name of Object.keys(env)) delete process.env[name];
    await delay(200);
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
  }
}

test("queued jobs run detached and results survive manager reconstruction", async t => {
  await scenario(t, "", async ({ manager, start, cwd, dataRoot }) => {
    const pending = start("fixture job");
    assert.equal(pending.state, "queued");
    const next = new JobManager(new ConfigManager(dataRoot), cwd, worker);
    const final = await next.wait(pending.id);
    assert.equal(final.state, "completed", JSON.stringify(final.error));
    assert.equal(manager.store.get(pending.id).phase, "completed");
    assert.equal(final.output.finalResponse, "Fixture completed");
    assert.equal(manager.sessions.require(final.threadId).lastJobId, final.id);
  });
});

test("two workers cancel via the owning broker and direct fallback", async t => {
  await scenario(t, "slow", async ({ manager, start, trace }) => {
    const first = start("fixture first");
    await until(() => manager.store.get(first.id)?.turnId);
    const second = start("fixture second");
    await until(() => manager.store.get(second.id)?.turnId);
    assert.throws(() => start("too many"), { code: "CONCURRENCY_LIMIT_REACHED" });
    for (const item of [first, second]) {
      const final = await manager.cancel(item.id);
      assert.equal(final.state, "cancelled", JSON.stringify(final.error));
      assert.equal(final.interruptAcknowledged, true);
    }
    assert.equal(fs.readFileSync(trace, "utf8").split("\n").filter(line => line.includes('"method":"turn/interrupt"')).length, 2);
  });
});

test("worker timeout cleans up the running turn", async t => {
  await scenario(t, "slow", async ({ manager, start }) => {
    const final = await manager.wait(start("fixture timeout", { timeoutSeconds: 10 }).id);
    assert.equal(final.state, "timed_out", JSON.stringify(final.error));
    assert.equal(final.interruptAcknowledged, true);
  });
});

test("dead worker recovery preserves its persistent thread", async t => {
  await scenario(t, "slow", async ({ manager, start }) => {
    const { id } = start("fixture crash");
    const live = await until(() => {
      const job = manager.store.get(id);
      return job?.turnId && job;
    });
    assert.equal(verifyProcessIdentity(live.identity), true);
    assert.equal(terminateVerifiedProcessTree(live.identity), true);
    const recovered = await manager.wait(id);
    assert.equal(recovered.state, "interrupted");
    assert.equal(recovered.threadId, live.threadId);
  });
});

test("a recycled worker PID releases its write lease on the next 5-second poll", async t => {
  await scenario(t, "", async ({ manager, start, cwd, dataRoot }) => {
    const id = randomUUID();
    const explicit = { sandbox: "workspace-write" };
    const identity = captureProcessIdentity(process.pid, id.replaceAll("-", ""), Date.now() - process.uptime() * 1000);
    const startedAt = new Date(identity.startedAtMs).toISOString();
    manager.store.create({
      id, state: "running", phase: "running", workspaceRoot: cwd, effectiveCwd: cwd,
      launchToken: identity.markerToken, identity, createdAt: startedAt, startedAt,
      request: { kind: "delegate", cwd, prompt: "simulated crashed worker", explicit },
    }, 2);
    new LockRegistry(dataRoot).reserve({
      jobId: id, workspaceRoot: cwd, cwd, sandbox: explicit.sandbox, recordFile: manager.store.file(id),
      reservedAtMs: identity.startedAtMs, limit: 2,
    }, () => true);

    assert.equal(manager.get(id).state, "running");
    // Observe probe completion without polling the job, even on a slow metadata command.
    await until(() => manager.probes.get(id)?.result === "dead");
    assert.ok(JSON.parse(fs.readFileSync(path.join(dataRoot, "locks.json"), "utf8")).some(lease => lease.jobId === id));
    await delay(5000);
    assert.equal(manager.get(id).state, "interrupted");
    assert.equal(manager.store.get(id).phase, "interrupted");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataRoot, "locks.json"), "utf8")), []);
    const replacement = await manager.wait(start("fixture replacement writer", explicit).id);
    assert.equal(replacement.state, "completed");
  });
});

test("a cancellation recorded just before persisting completion preserves the turn result", async t => {
  await scenario(t, "reroute", async ({ cwd, dataRoot }) => {
    const wrapper = path.join(dataRoot, "worker.mjs");
    const storeUrl = new URL("../../dist/lib/jobs/state-store.js", import.meta.url).href;
    fs.writeFileSync(wrapper, `
      import { JobStore } from ${JSON.stringify(storeUrl)};
      const update = JobStore.prototype.update;
      JobStore.prototype.update = function (id, expected, patch) {
        if (patch.state === "completed") update.call(this, id, ["running"], { state: "cancelling" });
        return update.call(this, id, expected, patch);
      };
      await import(${JSON.stringify(pathToFileURL(worker).href)});
    `);
    const manager = new JobManager(new ConfigManager(dataRoot), cwd, wrapper);
    const job = manager.create({ kind: "delegate", cwd, prompt: "fixture completion race" });
    const final = await manager.wait(job.id);
    assert.equal(final.state, "completed");
    assert.equal(manager.store.get(job.id).phase, "completed");
    assert.equal(final.output.finalResponse, "Fixture completed");
    assert.equal(final.effectiveModel, "fixture-model");
    assert.ok(final.turnId);
    assert.ok(final.warnings.includes("Codex reported a model reroute"));
  });
});

test("an unavailable metadata command preserves an active worker and its write lease", async t => {
  await scenario(t, "slow", async ({ manager, start, cwd, dataRoot }) => {
    const explicit = { sandbox: "workspace-write" };
    const { id } = start("fixture probe", explicit);
    const active = await until(() => {
      const job = manager.store.get(id);
      return job?.turnId && job;
    });
    const key = process.platform === "win32" ? "SystemRoot" : "PATH";
    const previous = process.env[key];
    try {
      process.env[key] = dataRoot;
      assert.equal(await probeProcessIdentityAsync(active.identity), "unknown");
      const uncached = new JobManager(new ConfigManager(dataRoot), cwd, worker);
      assert.equal(uncached.get(id).state, "running");
      assert.throws(() => uncached.create({ kind: "delegate", cwd, prompt: "must wait", explicit }), { code: "WORKSPACE_WRITE_LOCKED" });
      await delay(100);
      assert.equal(uncached.get(id).state, "running");
    } finally {
      process.env[key] = previous;
    }
    assert.equal(terminateVerifiedProcessTree(active.identity), true);
    assert.equal((await manager.wait(id)).state, "interrupted");
  });
});

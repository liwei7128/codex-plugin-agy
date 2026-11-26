import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { appendLog, JobStore, readLogChunk } from "../../dist/lib/jobs/index.js";

const root = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ca-")));
const job = (n, state = "queued") => ({
  id: randomUUID(), state, createdAt: new Date(1000 * n).toISOString(),
  request: { prompt: "Authorization: Bearer fixture-secret" }, launchToken: "f".repeat(32),
});

test("atomic multi-process-compatible writes and terminal CAS", async t => {
  const dir = root();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, "state");
  const store = new JobStore(dir, workspace, 2);
  const jobs = [job(1), job(2), job(3)];
  const moduleUrl = new URL("../../dist/lib/jobs/state-store.js", import.meta.url).href;
  await Promise.all(jobs.map(record => new Promise((resolve, reject) => {
    const worker = new Worker(`import(${JSON.stringify(moduleUrl)}).then(({JobStore})=>{
      new JobStore(${JSON.stringify(dir)}, ${JSON.stringify(workspace)}, 2).create(${JSON.stringify(record)},8);
    }).catch(e=>{throw e})`, { eval: true });
    worker.on("error", reject);
    worker.on("exit", code => code === 0 ? resolve() : reject(new Error("worker failed")));
  })));
  assert.equal(store.list().length, 3);
  fs.rmSync(path.join(workspace, "state.json"));
  assert.equal(store.list().length, 3);
  const id = jobs[0].id;
  assert.match(store.get(id).request.prompt, /REDACTED/);
  store.update(id, ["queued"], { state: "starting" });
  store.update(id, ["starting"], { state: "running" });
  store.update(id, ["running"], { state: "completed" });
  assert.equal(store.update(id, ["completed"], { state: "failed" }), undefined);
  assert.equal(store.get(id).state, "completed");
});

test("retention leaves active jobs and bounded logs preserve UTF-8", t => {
  const dir = root();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new JobStore(dir, path.join(dir, "state"), 2);
  const active = job(0);
  store.create(active, 8);
  for (let n = 1; n <= 4; n++) store.create(job(n, "completed"), 8);
  assert.equal(store.list().length, 3);
  assert.equal(store.get(active.id).state, "queued");
  const log = store.file(active.id, ".log");
  appendLog(log, "🙂abc");
  const p1 = readLogChunk(log, 0, 5);
  assert.equal(p1.text, "🙂a");
  assert.equal(readLogChunk(log, p1.nextCursor, 5).text, "bc\n");
});

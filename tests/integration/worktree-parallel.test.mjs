import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ConfigManager } from "../../dist/lib/config/index.js";
import { JobManager } from "../../dist/lib/jobs/index.js";
import { shutdownIdleBroker } from "../../dist/lib/app-server/index.js";

test("parallel write worktrees preserve a dirty checkout and surface conflicts and scope drift", async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ca-")));
  const cwd = path.join(root,"w");
  const dataRoot = path.join(root,"d");
  fs.mkdirSync(cwd); fs.mkdirSync(dataRoot);
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
      { cwd, shell: false, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const script = name => fileURLToPath(new URL("../../scripts/" + name + ".mjs", import.meta.url));
  const codeBin = process.env.CODEX_BIN;
  process.env.CODEX_BIN = fileURLToPath(new URL("../fixtures/mock-app-server.mjs", import.meta.url));
  const manager = new JobManager(new ConfigManager(dataRoot), cwd, script("task-worker"));
  const launch = (useWorktree, prompt = "fixture:parallel") => manager.create({
    kind: "delegate", cwd, prompt, useWorktree, explicit: { sandbox: "workspace-write" }, allowedPaths: ["in-scope.txt"],
  });
  try {
    git("init", "--quiet");
    const primary = path.join(cwd,"fixture.txt");
    fs.writeFileSync(primary,"versioned");
    git("add","--",".");
    git("commit","-m","initial");
    fs.writeFileSync(primary,"user changes");
    const first = launch(false, "fixture:slow");
    assert.throws(() => launch(false), { code: "WORKSPACE_WRITE_LOCKED" });
    assert.equal((await manager.cancel(first.id)).state, "cancelled");
    const jobs = [launch(true), launch(true)];
    const actualSpawnSync = spawnSync;
    let gitSnapshots = 0;
    childProcess.spawnSync = (file, args, ...options) => {
      if (file === "git" && args.includes("--show-toplevel")) gitSnapshots++;
      return actualSpawnSync(file, args, ...options);
    };
    syncBuiltinESMExports();
    let completed;
    try {
      completed = await Promise.all(jobs.map(job => manager.wait(job.id)));
    } finally {
      childProcess.spawnSync = actualSpawnSync;
      syncBuiltinESMExports();
    }
    assert.equal(gitSnapshots, 4, "one snapshot per sibling for each returned terminal record");
    for (const job of completed) assert.equal(job.state, "completed", JSON.stringify(job.error));
    assert.notEqual(completed[0].worktreePath, completed[1].worktreePath);
    assert.match(completed[0].worktreeBranch, /^codex-agy\//);
    assert.equal(fs.readFileSync(primary,"utf8"), "user changes");
    assert.equal(fs.readFileSync(path.join(completed[0].worktreePath,"fixture.txt"),"utf8"), "worktree fixture");
    assert.match(completed[0].warnings[0], /starts from HEAD/);
    assert.deepEqual(completed[0].outOfScopeFiles, ["fixture.txt"]);
    assert.deepEqual(manager.get(completed[0].id).fileConflicts, ["fixture.txt"]);
  } finally {
    if (codeBin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = codeBin;
    for (const job of manager.list()) {
      if (["queued", "starting", "running", "cancelling"].includes(job.state)) await manager.cancel(job.id);
      if (job.worktreePath) await shutdownIdleBroker({ dataRoot, script: script("app-server-broker") }, job.worktreePath);
    }
    await shutdownIdleBroker({ dataRoot, script: script("app-server-broker") }, cwd);
    await delay(200);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 });
  }
});

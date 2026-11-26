import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const enabled = process.env.CODEX_PLUGIN_AGY_RUN_LIVE_SMOKE === "1";

test("packaged MCP server runs local Codex gpt-6.2-sol in a throwaway repository",
  { skip: !enabled && "Set CODEX_PLUGIN_AGY_RUN_LIVE_SMOKE=1 to use the existing authorized Codex login", timeout: 240_000 },
  async t => {
    const { probeProcessIdentityAsync, readBrokerRecord, shutdownIdleBroker } = await import("../../dist/lib/app-server/index.js");
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ca-live-")));
    const cwd = path.join(dir, "work");
    const dataRoot = path.join(dir, "data");
    fs.mkdirSync(cwd);
    fs.mkdirSync(dataRoot);
    const git = (...args) => {
      const result = spawnSync("git", ["-c", "user.name=Smoke Fixture", "-c", "user.email=smoke@example.invalid", ...args],
        { cwd, shell: false, encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
    };
    git("init", "--quiet");
    fs.writeFileSync(path.join(cwd, "fixture.txt"), "APPLE-42\n");
    git("add", "--", "fixture.txt");
    git("commit", "--quiet", "-m", "Initialize smoke fixture");

    const pluginRoot = path.resolve("dist", "plugin");
    const script = path.join(pluginRoot, "scripts", "mcp-server.mjs");
    assert.ok(fs.existsSync(script), "Run npm run package first");
    const client = new Client({ name: "live-smoke", version: "1" }, { capabilities: { roots: { listChanged: true } } });
    client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [{ uri: pathToFileURL(cwd).href }] }));
    const env = { ...process.env, PLUGIN_ROOT: pluginRoot, CODEX_PLUGIN_AGY_DATA_DIR: dataRoot };
    const transport = new StdioClientTransport({ command: process.execPath, args: [script], cwd: pluginRoot, env });
    const call = async (name, args = {}, requireOk = true) => {
      const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: 130_000 })).structuredContent;
      if (requireOk) assert.ok(result.ok, name + " " + JSON.stringify(result.error));
      return result;
    };
    const runtime = { model: "gpt-6.2-sol", reasoning_effort: "low", timeout_seconds: 80 };
    const pending = new Set();
    try {
      await client.connect(transport);
      assert.ok((await call("codex_setup", { model: runtime.model, reasoning_effort: "high" })).pluginMeta.readiness.ready);
      t.diagnostic("Codex CLI, existing login, gpt-6.2-sol and high effort verified");

      const first = await call("codex_delegate", { ...runtime, background: true, sandbox: "read-only",
        task: "Read fixture.txt. Reply with its value only." });
      const id = first.pluginMeta.jobId;
      pending.add(id);
      let status = first.pluginMeta;
      while (status.recommendedPollIntervalMs) {
        await delay(status.recommendedPollIntervalMs);
        status = (await call("codex_status", { job_id: id }, false)).pluginMeta;
      }
      pending.delete(id);
      const analysis = await call("codex_result", { job_id: id });
      assert.equal(analysis.pluginMeta.state, "completed");
      assert.equal(analysis.pluginMeta.effectiveModel, runtime.model);
      assert.match(analysis.workerOutput.finalResponse, /APPLE-42/);
      const bounded = await call("codex_result", { job_id: id, max_bytes: 1024, include_logs: true });
      assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 1024);
      assert.equal(bounded.pluginMeta.sandbox, "read-only");
      assert.ok(bounded.pluginMeta.logsChunk.length);
      t.diagnostic("Read-only analysis, background status and stored result verified");

      const continued = await call("codex_resume", { ...runtime, thread_id: analysis.pluginMeta.threadId, task: "Reply only ACK." });
      assert.equal(continued.pluginMeta.threadId, analysis.pluginMeta.threadId);
      assert.match(continued.workerOutput.finalResponse, /ACK/);
      t.diagnostic("Persistent thread resume verified");

      const edit = await call("codex_delegate", { ...runtime, sandbox: "workspace-write", allowed_paths: ["worker.txt"],
        task: "Create worker.txt with the single line SMOKE-OK. Only change that file. Then stop." });
      assert.equal(edit.pluginMeta.sandbox, "workspace-write");
      assert.equal(fs.readFileSync(path.join(cwd, "worker.txt"), "utf8").trim(), "SMOKE-OK");
      t.diagnostic("Authorized workspace-write verified");

      const slow = await call("codex_delegate", { ...runtime, background: true, sandbox: "read-only",
        task: "Use a read-only command to inspect the repository and list the files." });
      pending.add(slow.pluginMeta.jobId);
      // Short polling is intentional in this smoke test to race cancellation against a tiny turn.
      let active;
      for (let n = 0; n < 30; n++) {
        active = (await call("codex_status", { job_id: slow.pluginMeta.jobId }, false)).pluginMeta;
        if (active.turnId || !active.recommendedPollIntervalMs) break;
        await delay(150);
      }
      const cancelled = await call("codex_cancel", { job_id: slow.pluginMeta.jobId });
      pending.delete(slow.pluginMeta.jobId);
      assert.equal(cancelled.pluginMeta.state, "cancelled");
      if (active.turnId) assert.equal(cancelled.pluginMeta.interruptAcknowledged, true);
      t.diagnostic(active.turnId ? "Live turn interruption acknowledged" : "Job cancelled before its turn ID was available");

      const review = await call("codex_review", { ...runtime, scope: "uncommitted" });
      assert.equal(review.pluginMeta.sandbox, "read-only");
      assert.equal(review.pluginMeta.state, "completed");
      assert.equal(typeof review.workerOutput.finalResponse, "string");
      t.diagnostic("Native read-only review verified");

      const record = readBrokerRecord(dataRoot, cwd);
      assert.ok(record);
      await client.close();
      for (let n = 0; n < 60 && readBrokerRecord(dataRoot, cwd); n++) await delay(50);
      assert.equal(readBrokerRecord(dataRoot, cwd), null);
      assert.equal(await probeProcessIdentityAsync(record.identity), "dead");
      t.diagnostic("Idle broker exited on packaged MCP EOF");
    } finally {
      for (const job_id of pending) await call("codex_cancel", { job_id }, false).catch(() => {});
      await client.close();
      await delay(250);
      await shutdownIdleBroker({ dataRoot, script: path.join(pluginRoot, "scripts", "app-server-broker.mjs") }, cwd);
      await delay(250);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
    }
  });

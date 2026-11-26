import assert from "node:assert/strict";
import test from "node:test";
import { diffStat, envelope, pollIntervalMs } from "../../dist/lib/formatting/index.js";

test("envelope separates trusted metadata and redacts worker text", () => {
  const id = "job-real";
  const output = { pluginMeta: { jobId: "spoofed" }, finalResponse: "sk-proj-" + "A".repeat(30) };
  const result = envelope("codex_result", { jobId: id }, output);
  assert.equal(result.pluginMeta.jobId, id);
  assert.equal(result.workerOutput.pluginMeta.jobId, "spoofed");
  assert.match(result.workerOutput.finalResponse, /REDACTED:OPENAI_KEY/);
  const error = { code: "INTERNAL_ERROR", message: "failed", retryable: false };
  assert.equal(envelope("codex_result", {}, output, error).workerOutput, null);
});

test("oversized structured output is byte-bounded and pages the same JSON source", () => {
  const output = { finalResponse: '🙂"\n'.repeat(1000) };
  let cursor = 0;
  let accumulated = "";
  do {
    const result = envelope("codex_result", { jobId: "fixture" }, output, undefined, 1024, cursor);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1024);
    assert.ok(result.pluginMeta.truncation.truncated);
    accumulated += result.workerOutput.jsonChunk;
    cursor = result.pluginMeta.truncation.nextCursor;
  } while (cursor !== null);
  assert.deepEqual(JSON.parse(accumulated), output);
});

test("a 1 KiB result preserves critical metadata and advances all three evidence streams without losing bytes", () => {
  const fullLogs = 'log 🙂\n"'.repeat(40);
  const fullDiff = "+change 日本\n".repeat(40);
  const worker = { finalResponse: "worker🙂".repeat(300) };
  const metadata = {
    jobId: "fixture", state: "completed", sandbox: "workspace-write", approvalPolicy: "on-request",
    worktreePath: "/fixture/repo/worktree", worktreeBranch: "codex-agy/fixture", outOfScopeFiles: ["out.txt", "another.txt"],
    fileConflicts: ["overlap.txt", "another.txt"], warnings: ["Scope drift", "Model rerouted"],
    modelRerouted: { fromModel: "model-a", toModel: "model-b", reason: "fixture" },
    pendingApproval: { method: "fixture/approval", params: { title: "Fixture" } },
  };
  const bytePage = (value, cursor) => {
    if (cursor === null) return { text: undefined, next: null };
    const bytes = Buffer.from(value);
    const end = Math.min(cursor + 240, bytes.length);
    let boundary = end;
    while (boundary < bytes.length && (bytes[boundary] & 0xc0) === 0x80) boundary--;
    return { text: bytes.subarray(cursor, boundary).toString(), next: boundary < bytes.length ? boundary : null };
  };
  let log = 0, diff = 0, cursor = 0;
  let logs = "", patch = "", json = "";
  for (let n = 0; n < 150 && (log !== null || diff !== null || cursor !== null); n++) {
    const l = bytePage(fullLogs, log);
    const d = bytePage(fullDiff, diff);
    const result = envelope("codex_result", { ...metadata, logsChunk: l.text, nextLogCursor: l.next, nextDiffCursor: d.next },
      { ...worker, gitDiffPatch: d.text }, undefined, 1024, cursor ?? Buffer.byteLength(JSON.stringify(worker)),
      { log: log ?? undefined, diff: diff ?? undefined });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1024);
    for (const key of ["sandbox", "approvalPolicy", "worktreePath", "worktreeBranch", "modelRerouted", "pendingApproval"]) {
      assert.deepEqual(result.pluginMeta[key], metadata[key], key);
    }
    for (const key of ["outOfScopeFiles", "fileConflicts", "warnings"]) {
      assert.equal(result.pluginMeta[key][0], metadata[key][0]);
      assert.equal(result.pluginMeta[key + "Count"], 2);
    }
    if (log !== null) {
      logs += result.pluginMeta.logsChunk;
      assert.ok(result.pluginMeta.nextLogCursor === null || result.pluginMeta.nextLogCursor > log);
      log = result.pluginMeta.nextLogCursor;
    }
    if (diff !== null) {
      patch += result.workerOutput.gitDiffPatch;
      assert.ok(result.pluginMeta.nextDiffCursor === null || result.pluginMeta.nextDiffCursor > diff);
      diff = result.pluginMeta.nextDiffCursor;
    }
    if (cursor !== null) {
      json += result.workerOutput.jsonChunk;
      assert.ok(result.pluginMeta.truncation.nextCursor === null || result.pluginMeta.truncation.nextCursor > cursor);
      cursor = result.pluginMeta.truncation.nextCursor;
    }
  }
  assert.deepEqual([log, diff, cursor], [null, null, null]);
  assert.equal(logs, fullLogs);
  assert.equal(patch, fullDiff);
  assert.deepEqual(JSON.parse(json), worker);
});

test("summarize emitted diff and adapt active polling", () => {
  assert.equal(diffStat(null), null);
  assert.deepEqual(diffStat("diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n"), {
    files: ["a/a b/a"], insertions: 1, deletions: 1, source: "turn/diff/updated",
  });
  assert.deepEqual([0, 30, 120].map(pollIntervalMs), [5000, 10000, 15000]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { assertTransition, isActive, jobStates } from "../../dist/lib/jobs/index.js";

test("all ten states enforce the documented transition graph", () => {
  const allowed = {
    queued: ["starting", "cancelling", "failed", "interrupted"],
    starting: ["running", "awaiting_approval", "cancelling", "failed", "timed_out", "interrupted"],
    running: ["awaiting_approval", "completed", "failed", "cancelling", "timed_out", "interrupted"],
    awaiting_approval: ["running", "cancelled"],
    cancelling: ["cancelled", "completed", "failed", "interrupted"],
    completed: [], failed: [], cancelled: [], timed_out: [], interrupted: [],
  };
  for (const from of jobStates) for (const target of jobStates) {
    if (allowed[from].includes(target)) assert.doesNotThrow(() => assertTransition(from, target));
    else assert.throws(() => assertTransition(from, target), { code: "INTERNAL_ERROR" });
  }
  assert.deepEqual(jobStates.filter(isActive), ["queued", "starting", "running", "cancelling"]);
});

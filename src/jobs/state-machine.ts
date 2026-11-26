import { PluginError } from "../security/index.js";
import type { JobState } from "./types.js";

const next: Record<JobState, readonly JobState[]> = {
  queued: ["starting", "cancelling", "failed", "interrupted"],
  starting: ["running", "awaiting_approval", "cancelling", "failed", "timed_out", "interrupted"],
  running: ["awaiting_approval", "completed", "failed", "cancelling", "timed_out", "interrupted"],
  awaiting_approval: ["running", "cancelled"],
  cancelling: ["cancelled", "completed", "failed", "interrupted"],
  completed: [], failed: [], cancelled: [], timed_out: [], interrupted: [],
};

export function canTransition(from: JobState, to: JobState): boolean {
  return next[from].includes(to);
}

export function assertTransition(from: JobState, to: JobState): void {
  if (!canTransition(from, to)) {
    throw new PluginError("INTERNAL_ERROR", "Invalid job state transition from " + from + " to " + to);
  }
}

export function isActive(state: JobState): boolean {
  return state === "queued" || state === "starting" || state === "running" || state === "cancelling";
}

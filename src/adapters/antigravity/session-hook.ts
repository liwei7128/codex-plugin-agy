import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ConfigManager } from "../../config/index.js";
import { readJsonFile, withFileLock, writeJsonFile } from "../../upstream/fs.mjs";
import { canonicalDirectory, pathInWorkspace, PluginError } from "../../security/index.js";
import { snapshotChanges } from "../../workspace/index.js";
import type { HookInput } from "./types.js";

export interface Observation {
  promptHash: string;
  execution: number;
  runs: number;
  changed: Record<string, string>;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const promptHash = (input: HookInput) => hash(input.lastUserInput ?? "");

export function hookWorkspace(input: HookInput) {
  const candidates = input.workspacePaths.filter(root => path.isAbsolute(root)).flatMap(root => {
    try { return [canonicalDirectory(root)]; } catch { return []; }
  });
  if (!input.cwd && candidates.length) return { root: candidates[0], cwd: candidates[0] };
  if (input.cwd && path.isAbsolute(input.cwd)) {
    for (const root of candidates.sort((a, b) => b.length - a.length)) {
      try { return { root, cwd: canonicalDirectory(pathInWorkspace(root, input.cwd)) }; }
      catch { /* Try any remaining workspace roots. */ }
    }
  }
  throw new PluginError("PATH_OUTSIDE_WORKSPACE", "Hook working directory is outside the supplied workspaces");
}

export function observe(cwd: string, root: string) {
  const snapshot = snapshotChanges(cwd, root);
  return {
    snapshot,
    fingerprints: Object.fromEntries([...snapshot].map(([file, stamp]) => [hash(file), stamp])),
  };
}

export function updateObservation<T>(
  config: ConfigManager, root: string, input: HookInput,
  update: (previous: Observation | undefined) => { next?: Observation; value: T },
): T {
  const directory = pathInWorkspace(config.root, config.workspaceDirectory(root), true);
  fs.mkdirSync(directory, { mode: 0o700, recursive: true });
  return withFileLock(path.join(directory, ".review-gate.lock"), () => {
    const file = pathInWorkspace(config.root, path.join(directory, "review-gate-state.json"), true);
    let observations: Record<string, Observation> = {};
    try {
      if (fs.statSync(file).size > 4 * 1024 * 1024) throw new Error("Review Gate state is oversized");
      observations = readJsonFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const key = hash(input.conversationId);
    const { next, value } = update(observations[key]);
    if (next) {
      delete observations[key];
      const recent = Object.entries(observations).slice(-49);
      writeJsonFile(file, Object.fromEntries([...recent, [key, next]]));
    }
    return value;
  });
}

export function sessionStart(config: ConfigManager, root: string, cwd: string, input: HookInput): void {
  if (!config.resolve(root).reviewGate.enabled) return;
  const observation = observe(cwd, root);
  updateObservation(config, root, input, previous => ({
    next: previous ?? { promptHash: promptHash(input), execution: -1, runs: 0, changed: observation.fingerprints },
    value: undefined,
  }));
}

export function filesChangedSince(
  snapshot: Map<string, string>, last: Record<string, string>,
): string[] {
  return [...snapshot].filter(([file, stamp]) => last[hash(file)] !== stamp).map(([file]) => file);
}

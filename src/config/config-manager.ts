import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { readJsonFile, withFileLock, writeJsonFile } from "../upstream/fs.mjs";
import { assertSafeOption, canonicalDirectory, isApprovalName, isSandbox, pathInWorkspace, PluginError } from "../security/index.js";
import type { CodexBaseline } from "../security/policy.js";
import type { ConfigOverrides, PluginConfig } from "./types.js";

export const defaults: Readonly<PluginConfig> = Object.freeze({
  model: "gpt-6.2-sol", reasoningEffort: "high", sandbox: "read-only", approvalPolicy: "never",
  timeoutSeconds: 600, maxConcurrency: 2, jobRetentionCount: 50, orchestrationMode: "delegated",
  reviewGate: Object.freeze({ enabled: false, maxRunsPerTurn: 2, timeoutSeconds: 120 }),
});

export function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const root = path.resolve(env.CODEX_PLUGIN_AGY_DATA_DIR || env.PLUGIN_DATA ||
    path.join(os.homedir(), ".gemini", "antigravity-codex-plugin-data"));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return canonicalDirectory(root);
}

export function workspaceKey(workspace: string): string {
  const normalized = process.platform === "win32" ? workspace.toLowerCase() : workspace;
  const slug = path.basename(normalized).replace(/[^a-z0-9_-]/gi, "-").slice(0, 32) || "workspace";
  return slug + "-" + createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inRange(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export function validateConfig(value: unknown): ConfigOverrides {
  if (!plainObject(value)) throw new PluginError("INVALID_ARGUMENTS", "Plugin configuration must be an object");
  const gate = (input: unknown) => plainObject(input) && Object.entries(input).every(([key, item]) => {
    if (key === "enabled") return typeof item === "boolean";
    if (key === "maxRunsPerTurn") return inRange(item, 1, 5);
    if (key === "timeoutSeconds") return inRange(item, 30, 300);
    return false;
  });
  const id = (input: unknown) => typeof input === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(input);
  const rules: Record<string, (input: unknown) => boolean> = {
    model: id, reasoningEffort: id, sandbox: isSandbox, approvalPolicy: isApprovalName,
    timeoutSeconds: input => inRange(input, 10, 3600),
    maxConcurrency: input => inRange(input, 1, 8),
    jobRetentionCount: input => inRange(input, 10, 500),
    orchestrationMode: input => ["assisted", "delegated", "review", "parallel"].some(mode => mode === input),
    reviewGate: gate,
  };
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") assertSafeOption(item);
    if (!Object.hasOwn(rules, key) || !rules[key](item)) {
      throw new PluginError("INVALID_ARGUMENTS", "Invalid plugin configuration field");
    }
  }
  return value as ConfigOverrides;
}

function readConfig(file: string): ConfigOverrides {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new PluginError("INVALID_ARGUMENTS", "Plugin configuration must be a local regular file");
    return validateConfig(readJsonFile(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof PluginError) throw error;
    throw new PluginError("INVALID_ARGUMENTS", "Plugin configuration could not be read");
  }
}

function validateOverrides(value: unknown): ConfigOverrides {
  if (!plainObject(value)) return validateConfig(value);
  const entries = Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [
    key, key === "reviewGate" && plainObject(item)
      ? Object.fromEntries(Object.entries(item).filter(([, field]) => field !== undefined)) : item,
  ]);
  return validateConfig(Object.fromEntries(entries));
}

export class ConfigManager {
  constructor(readonly root = dataRoot()) {}

  workspaceDirectory(workspace: string): string {
    return pathInWorkspace(this.root, path.join("state", workspaceKey(canonicalDirectory(workspace))), true);
  }

  resolve(workspace: string, explicit: ConfigOverrides = {}, codex: CodexBaseline = {}): PluginConfig {
    const global = readConfig(path.join(this.root, "config.json"));
    const local = readConfig(path.join(this.workspaceDirectory(workspace), "config.json"));
    explicit = validateOverrides(explicit);
    const config: PluginConfig = {
      ...defaults,
      model: codex.model ?? defaults.model,
      reasoningEffort: codex.model_reasoning_effort ?? defaults.reasoningEffort,
      approvalPolicy: isApprovalName(codex.approval_policy) ? codex.approval_policy : defaults.approvalPolicy,
      ...global, ...local, ...explicit,
      reviewGate: { ...defaults.reviewGate, ...global.reviewGate, ...local.reviewGate, ...explicit.reviewGate },
    };
    // A configured default never constitutes authorization for a write turn.
    config.sandbox = explicit.sandbox ?? "read-only";
    validateConfig(config);
    return config;
  }

  update(overrides: ConfigOverrides, workspace?: string): ConfigOverrides {
    overrides = validateOverrides(overrides);
    const directory = workspace ? this.workspaceDirectory(workspace) : this.root;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "config.json");
    return withFileLock(path.join(directory, ".config.lock"), () => {
      const current = readConfig(file);
      const updated = {
        ...current, ...overrides,
        reviewGate: { ...current.reviewGate, ...overrides.reviewGate },
      };
      writeJsonFile(file, updated);
      return updated;
    });
  }
}

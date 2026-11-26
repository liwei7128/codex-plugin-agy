import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AppServerRpcError, brokerHealth, checkCodexVersion, connectDirect, resolveSupportedCodex } from "../app-server/index.js";
import type { ConfigOverrides } from "../config/index.js";
import { checkAccount, readBaseline, runtimeError, validateModel } from "../runtime/index.js";
import type { RuntimeContext } from "../runtime/index.js";
import { canonicalDirectory, errorInfo, PluginError, SecretRedactor } from "../security/index.js";
import type { ErrorInfo } from "../security/index.js";

interface Check {
  name: string;
  status: "ok" | "warning" | "error";
  detail: unknown;
}

function npmAvailable(): boolean {
  const candidates = (process.env.PATH ?? "").split(path.delimiter).map(dir => dir.replace(/^"(.*)"$/, "$1"));
  const filename = process.platform === "win32" ? "npm.cmd" : "npm";
  return candidates.some(dir => path.isAbsolute(dir) && !(process.platform === "win32" && /^[\\/]{2}/.test(dir)) &&
    fs.existsSync(path.join(dir, filename)));
}

const redactor = new SecretRedactor();

export async function runSetup(
  context: RuntimeContext, workspaceRoot: string, cwd: string, overrides: ConfigOverrides = {}, probeBroker = true,
) {
  const checks: Check[] = [];
  const errors: ErrorInfo[] = [];
  const report = (name: string, status: Check["status"], detail: unknown) => checks.push({ name, status, detail });
  const addError = (name: string, error: unknown) => {
    const info = errorInfo(runtimeError(error));
    errors.push(info);
    report(name, "error", info);
  };

  const [major, minor] = process.versions.node.split(".").map(Number);
  report("node", major > 18 || (major === 18 && minor >= 18) ? "ok" : "error", process.version);
  const npm = npmAvailable();
  report("npm", npm ? "ok" : "warning", npm ? "Found on PATH" : "Needed for building from source");
  const git = spawnSync("git", ["--version"], { cwd, shell: false, encoding: "utf8", windowsHide: true, timeout: 5000 });
  report("git", git.status === 0 ? "ok" : "warning", git.status === 0 ? git.stdout.trim() : "Install Git to use reviews and worktrees");
  report("cwd", "ok", canonicalDirectory(cwd));
  try {
    report("pluginConfig", "ok", context.config.resolve(workspaceRoot, overrides));
  } catch (error) {
    addError("pluginConfig", error);
  }

  let binary;
  try {
    const local = context.binary ? { binary: context.binary, version: checkCodexVersion(context.binary, cwd) }
      : resolveSupportedCodex(cwd);
    binary = local.binary;
    report("codexCli", "ok", local.version);
  } catch (error) {
    addError("codexCli", error);
    return redactor.deep({ ready: false, checks, errors });
  }
  try {
    const client = await connectDirect(cwd, binary);
    try {
      report("appServer", "ok", "Initialized over JSONL stdio");
      const response = await client.request("config/read", { cwd, includeLayers: true });
      const baseline = readBaseline(response);
      const projects = Array.isArray(response.layers) ? response.layers.filter(layer => layer.name?.type === "project") : [];
      const disabled = projects.filter(layer => !!layer.disabledReason).map(layer => layer.disabledReason);
      report("projectTrust", disabled.length ? "warning" : "ok", {
        status: disabled.length ? "untrusted" : projects.length ? "enabled" : "no_project_config_layer",
        disabledReasons: disabled,
      });

      const account = await client.request("account/read", { refreshToken: false });
      try {
        const auth = checkAccount(account);
        report("auth", "ok", auth);
        const config = context.config.resolve(workspaceRoot, overrides, baseline);
        try {
          const model = await validateModel(client, config.model, config.reasoningEffort, {
            requiresOpenaiAuth: account.requiresOpenaiAuth, modelProvider: baseline.model_provider,
          });
          report("model", model.status === "verified" ? "ok" : "warning", {
            requestedModel: config.model, reasoningEffort: config.reasoningEffort, validation: model.status,
            supportedEfforts: model.model?.supportedReasoningEfforts.map(value => value.reasoningEffort) ?? [],
          });
        } catch (error) {
          addError("model", error);
        }
      } catch (error) {
        addError("auth", error);
      }
      if (process.platform === "win32") {
        try {
          const readiness = await client.request("windowsSandbox/readiness", undefined);
          report("windowsSandbox", readiness.status === "ready" ? "ok" : "warning", readiness.status);
        } catch (error) {
          report("windowsSandbox", "warning", error instanceof AppServerRpcError ? error.message : "Readiness unavailable");
        }
      }
    } finally {
      await client.close();
    }
  } catch (error) {
    addError(checks.some(check => check.name === "appServer") ? "appServerPreflight" : "appServer", error);
  }
  if (probeBroker) {
    try {
      const health = context.broker ? await brokerHealth(context.broker, cwd) : null;
      report("broker", "ok", health ?? "Cold, starts on demand");
    } catch (error) {
      report("broker", "warning", errorInfo(runtimeError(error)));
    }
  }
  return redactor.deep({ ready: !checks.some(check => check.status === "error"), checks, errors });
}

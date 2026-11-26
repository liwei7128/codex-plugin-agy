import fs from "node:fs";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { assertSafeOption, PluginError } from "../security/index.js";

interface ResolverOptions { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; execPath?: string }
export interface CodexBinary { executable: string; prefix: string[]; kind: "native" | "npm" | "cmd" }

function file(filePath: string, executable = false): boolean {
  try {
    if (executable) fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function windowsShim(shim: string, execPath: string, env: NodeJS.ProcessEnv): CodexBinary | null {
  if (!file(shim)) return null;
  const nodeScript = path.join(path.dirname(shim), "node_modules", "@openai", "codex", "bin", "codex.js");
  if (fs.statSync(shim).size <= 16_384 && file(nodeScript) &&
      /node_modules[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js/i.test(fs.readFileSync(shim, "utf8"))) {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const target = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
    const packageRoot = path.resolve(path.dirname(nodeScript), "..");
    const nativePackage = "@openai/codex-win32-" + arch;
    for (const dependencies of [path.join(packageRoot, "node_modules"), path.resolve(packageRoot, "..", "..")]) {
      const native = path.join(dependencies, nativePackage, "vendor", target, "bin", "codex.exe");
      if (file(native)) return { executable: native, prefix: [], kind: "native" };
    }
    return { executable: execPath, prefix: [nodeScript], kind: "npm" };
  }
  // Batch shims receive only fixed app-server switches. Reject shell expansion characters.
  if (/["%&|<>^!()\r\n]/.test(shim)) return null;
  const cmd = path.join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32", "cmd.exe");
  return { executable: cmd, prefix: [shim], kind: "cmd" };
}

export function resolveCodexBinary({ env = process.env, platform = process.platform, execPath = process.execPath }: ResolverOptions = {}): CodexBinary {
  const windows = platform === "win32";
  const override = env.CODEX_BIN;
  if (override !== undefined) {
    assertSafeOption(override);
    const nodeScript = /\.(?:js|mjs)$/i.test(override);
    if (path.isAbsolute(override) && !/[\x00-\x1f"%&|<>^!]/.test(override) &&
        !(windows && /^[\\/]{2}/.test(override)) && file(override, !windows && !nodeScript)) {
      const real = fs.realpathSync.native(override);
      if (/\.(?:js|mjs)$/i.test(real)) return { executable: execPath, prefix: [real], kind: "npm" };
      if (!windows || /\.exe$/i.test(real)) return { executable: real, prefix: [], kind: "native" };
      if (/\.cmd$/i.test(real)) {
        const shim = windowsShim(real, execPath, env);
        if (shim) return shim;
      }
    }
    throw new PluginError("CODEX_NOT_INSTALLED", "CODEX_BIN does not point to a supported Codex executable");
  }
  const directories = (env.PATH ?? env.Path ?? "").split(windows ? ";" : ":").map(value => value.replace(/^"(.*)"$/, "$1")).filter(value => path.isAbsolute(value));
  for (const directory of directories) {
    if (windows && /^[\\/]{2}/.test(directory)) continue;
    const candidate = path.join(directory, windows ? "codex.exe" : "codex");
    if (file(candidate, !windows)) return { executable: candidate, prefix: [], kind: "native" };
  }
  if (windows) {
    for (const directory of directories) {
      if (/^[\\/]{2}/.test(directory)) continue;
      const shim = windowsShim(path.join(directory, "codex.cmd"), execPath, env);
      if (shim) return shim;
    }
  }
  throw new PluginError("CODEX_NOT_INSTALLED", "Codex CLI was not found on PATH", { remediation: ["Install the official Codex CLI."] });
}

export function codexArgv(binary: CodexBinary, args: string[]) {
  args.forEach(assertSafeOption);
  if (binary.kind !== "cmd") return { args: [...binary.prefix, ...args], windowsVerbatimArguments: false };
  if (!["--version", "app-server", "app-server --help"].includes(args.join(" ")) ||
      args.some(arg => arg.includes(" "))) {
    throw new PluginError("POLICY_VIOLATION", "Unrecognized arguments for a Windows Codex command shim");
  }
  const [shim] = binary.prefix;
  return { args: ["/d", "/s", "/c", '""' + shim + '" ' + args.join(" ") + '"'], windowsVerbatimArguments: true };
}

export function probeCodex(binary: CodexBinary, args: string[], cwd: string): SpawnSyncReturns<string> {
  return spawnSync(binary.executable, codexArgv(binary, args).args, {
    cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 512 * 1024, shell: false, windowsHide: true,
    windowsVerbatimArguments: binary.kind === "cmd",
  });
}

export function checkCodexVersion(binary: CodexBinary, cwd: string): string {
  const result = probeCodex(binary, ["--version"], cwd);
  if (result.status !== 0) throw new PluginError("CODEX_NOT_INSTALLED", "Cannot run the Codex CLI",
    { remediation: ["Install or repair the official Codex CLI."] });
  const match = result.stdout.match(/\bcodex-cli\s+(\d+)\.(\d+)\.(\d+)/);
  if (!match || (Number(match[1]) === 0 && Number(match[2]) < 172)) {
    throw new PluginError("CODEX_VERSION_UNSUPPORTED", "Codex CLI 0.172.0 or later is required",
      { remediation: ["Set CODEX_BIN to the absolute path of a supported local Codex executable."] });
  }
  return match[0];
}

export function resolveSupportedCodex(cwd: string): { binary: CodexBinary; version: string } {
  const binary = resolveCodexBinary();
  try {
    return { binary, version: checkCodexVersion(binary, cwd) };
  } catch (error) {
    // The Windows desktop app can put an older App Server executable on PATH
    // alongside the supported official npm CLI. Keep explicit overrides strict.
    if (process.platform !== "win32" || process.env.CODEX_BIN ||
        !(error instanceof PluginError) || error.code !== "CODEX_VERSION_UNSUPPORTED") throw error;
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      const local = directory.replace(/^"(.*)"$/, "$1");
      if (!path.isAbsolute(local) || local.startsWith("\\\\")) continue;
      const candidate = windowsShim(path.join(local, "codex.cmd"), process.execPath, process.env);
      if (!candidate || candidate.kind === "cmd") continue;
      try { return { binary: candidate, version: checkCodexVersion(candidate, cwd) }; }
      catch { /* Keep checking official npm candidates. */ }
    }
    throw error;
  }
}

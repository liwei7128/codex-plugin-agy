import { execFile, spawnSync } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

export interface ProcessIdentity {
  pid: number;
  startedAtMs: number;
  markerToken: string;
  executable: string;
}

export type ProcessProbe = "alive" | "dead" | "unknown";
interface ProcessMetadata { start: number; executable: string; argv: string; group?: number }
type ProbeResult = ProcessMetadata | "dead" | "unknown";
const execFileAsync = promisify(execFile);

export function processPresence(identity: ProcessIdentity): ProcessProbe {
  const { pid, markerToken } = identity;
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid > 0x7fffffff || !/^[a-f0-9]{32}$/.test(markerToken)) return "dead";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
}

function metadataCommand(pid: number) {
  const options = { encoding: "utf8" as const, shell: false as const, windowsHide: true, timeout: 5000, maxBuffer: 512 * 1024 };
  if (process.platform === "win32") {
    const file = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = "$ErrorActionPreference = 'Stop'; $p = Get-CimInstance Win32_Process -Filter 'ProcessId = " + pid + "'; " +
      "if ($p) { [pscustomobject]@{start=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds();" +
      "executable=$p.ExecutablePath;argv=$p.CommandLine} | ConvertTo-Json -Compress }";
    return { file, args: ["-NoProfile", "-NonInteractive", "-Command", script], options };
  }
  return { file: "ps", args: ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "pgid=", "-o", "comm=", "-o", "args="],
    options: { ...options, env: { ...process.env, LC_ALL: "C" } } };
}

function matchMetadata(identity: ProcessIdentity, stdout: string): ProbeResult {
  const output = stdout.trim();
  if (!output) return "dead";
  let found: ProcessMetadata;
  if (process.platform === "win32") {
    found = JSON.parse(output);
  } else {
    const fields = output.match(/^(.{24})\s+(\d+)\s+(\S+)\s+(.+)$/s);
    if (!fields) return "unknown";
    found = { start: Date.parse(fields[1]), group: Number(fields[2]), executable: fields[3], argv: fields[4] };
  }
  if (found && Number.isFinite(found.start) && Math.abs(found.start - identity.startedAtMs) > 5000) return "dead";
  if (!found || typeof found.argv !== "string" || typeof found.executable !== "string" || !Number.isFinite(found.start)) return "unknown";
  if (path.basename(found.executable).toLowerCase() !== path.basename(identity.executable).toLowerCase() ||
      !found.argv.split(/\s+/).some(arg => arg.replace(/^"(.*)"$/, "$1") === identity.markerToken)) return "dead";
  return found;
}

function inconclusive(identity: ProcessIdentity): "dead" | "unknown" {
  return processPresence(identity) === "dead" ? "dead" : "unknown";
}

function matching(identity: ProcessIdentity): ProbeResult {
  const presence = processPresence(identity);
  if (presence !== "alive") return presence;
  const { file, args, options } = metadataCommand(identity.pid);
  try {
    const result = spawnSync(file, args, options);
    return result.status === 0 ? matchMetadata(identity, result.stdout) : inconclusive(identity);
  } catch {
    return inconclusive(identity);
  }
}

export function probeProcessIdentity(identity: ProcessIdentity): ProcessProbe {
  const result = matching(identity);
  return typeof result === "string" ? result : "alive";
}

export async function probeProcessIdentityAsync(identity: ProcessIdentity): Promise<ProcessProbe> {
  const presence = processPresence(identity);
  if (presence !== "alive") return presence;
  const { file, args, options } = metadataCommand(identity.pid);
  try {
    const { stdout } = await execFileAsync(file, args, options);
    const result = matchMetadata(identity, stdout);
    return typeof result === "string" ? result : "alive";
  } catch {
    return inconclusive(identity);
  }
}

export function captureProcessIdentity(pid: number, markerToken: string, startedAtMs = Date.now()): ProcessIdentity {
  return { pid, startedAtMs, markerToken, executable: process.execPath };
}

export function verifyProcessIdentity(identity: ProcessIdentity): boolean {
  return probeProcessIdentity(identity) === "alive";
}

export function terminateVerifiedProcessTree(identity: ProcessIdentity, force = true): boolean {
  const verified = matching(identity);
  if (typeof verified === "string") return false;
  try {
    if (process.platform === "win32") {
      if (!force) return false;
      const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
      return spawnSync(taskkill, ["/PID", String(identity.pid), "/T", "/F"],
        { shell: false, windowsHide: true, stdio: "ignore", timeout: 3000 }).status === 0;
    }
    process.kill(force && verified.group === identity.pid ? -identity.pid : identity.pid, force ? "SIGKILL" : "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

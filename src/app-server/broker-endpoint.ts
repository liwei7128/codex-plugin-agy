import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { pathInWorkspace, PluginError } from "../security/index.js";

export function brokerDirectory(root: string, cwd: string): string {
  const key = process.platform === "win32" ? cwd.toLowerCase() : cwd;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const run = pathInWorkspace(root, "run", true);
  const directory = pathInWorkspace(root, path.join(run, hash), true);
  fs.mkdirSync(directory, { mode: 0o700, recursive: true });
  if (process.platform !== "win32") {
    fs.chmodSync(run, 0o700);
    fs.chmodSync(directory, 0o700);
  }
  return directory;
}

export function makeBrokerEndpoint(directory: string, platform = process.platform): string {
  const name = randomBytes(8).toString("hex");
  if (platform === "win32") return "pipe:\\\\.\\pipe\\codex-agy-" + name;
  return "unix:" + path.join(directory, name + ".sock");
}

export function endpointPath(endpoint: string): string {
  if (/^pipe:\\\\\.\\pipe\\codex-agy-[a-f0-9]{16}$/.test(endpoint)) return endpoint.slice(5);
  if (endpoint.startsWith("unix:") && path.isAbsolute(endpoint.slice(5)) &&
      /^[a-f0-9]{16}\.sock$/.test(path.basename(endpoint.slice(5))) &&
      Buffer.byteLength(endpoint.slice(5)) <= 103 && !/[\x00-\x1f]/.test(endpoint)) return endpoint.slice(5);
  throw new PluginError("APP_SERVER_START_FAILED", "Invalid or oversized local broker endpoint");
}

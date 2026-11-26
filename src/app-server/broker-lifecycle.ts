import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readJsonFile, withFileLock, writeJsonFile } from "../upstream/fs.mjs";
import { PluginError, samePath } from "../security/index.js";
import { captureProcessIdentity, probeProcessIdentityAsync, processPresence, type ProcessIdentity } from "./process.js";
import { brokerDirectory, endpointPath, makeBrokerEndpoint } from "./broker-endpoint.js";
import { AppServerRpcError, BROKER_BUSY_RPC_CODE, connectBrokerSocket, connectDirect } from "./client.js";
import type { CodexBinary } from "./binary-resolver.js";

export interface BrokerRecord {
  endpoint: string;
  authToken: string;
  identity: ProcessIdentity;
  cwd: string;
}

export interface BrokerOptions {
  dataRoot: string;
  script: string;
  idleMs?: number;
}

function loadRecord(file: string): BrokerRecord | null {
  try {
    const record = readJsonFile(file) as BrokerRecord;
    if (typeof record.endpoint !== "string" || !/^[a-f0-9]{64}$/.test(record.authToken) ||
        !record.identity || !Number.isSafeInteger(record.identity.pid) ||
        !Number.isFinite(record.identity.startedAtMs) || typeof record.identity.executable !== "string" ||
        typeof record.cwd !== "string") return null;
    const socket = endpointPath(record.endpoint);
    if (process.platform !== "win32" && (!record.endpoint.startsWith("unix:") || path.dirname(socket) !== path.dirname(file))) return null;
    if (process.platform === "win32" && !record.endpoint.startsWith("pipe:")) return null;
    return record;
  } catch {
    return null;
  }
}

function brokerFile(dataRoot: string, cwd: string) {
  return path.join(brokerDirectory(dataRoot, cwd), "broker.json");
}

export function readBrokerRecord(dataRoot: string, cwd: string): BrokerRecord | null {
  return loadRecord(brokerFile(dataRoot, cwd));
}

function loadOrSpawn(file: string, cwd: string, options: BrokerOptions, replaced?: BrokerRecord): BrokerRecord {
  return withFileLock(path.join(path.dirname(file), ".broker.lock"), () => {
    const prior = loadRecord(file);
    if (prior && prior.identity.markerToken !== replaced?.identity.markerToken) return prior;

    const marker = randomBytes(16).toString("hex");
    const endpoint = makeBrokerEndpoint(path.dirname(file));
    endpointPath(endpoint);
    const startedAtMs = Date.now();
    const child = spawn(process.execPath, [options.script, file, marker, String(options.idleMs ?? 900_000)], {
      cwd, shell: false, detached: true, stdio: "ignore", windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
    if (!child.pid) throw new PluginError("APP_SERVER_START_FAILED", "Could not launch local broker");
    const record = {
      endpoint, authToken: randomBytes(32).toString("hex"), cwd,
      identity: captureProcessIdentity(child.pid, marker, startedAtMs),
    };
    writeJsonFile(file, record);
    return record;
  });
}

async function pruneOrphanSockets(file: string, current: BrokerRecord) {
  if (process.platform === "win32") return;
  const directory = path.dirname(file);
  const activeEndpoint = endpointPath(current.endpoint);
  const candidates = fs.readdirSync(directory).filter(name => /^[a-f0-9]{16}\.sock$/.test(name)).slice(0, 128);
  await Promise.allSettled(candidates.map(async name => {
    const filename = path.join(directory, name);
    if (filename === activeEndpoint || filename === endpointPath(loadRecord(file)?.endpoint ?? current.endpoint)) return;
    const previous = fs.lstatSync(filename);
    if (!previous.isSocket()) return;
    const disconnected = await new Promise<boolean>(resolve => {
      const socket = net.createConnection(filename);
      const finish = (refused: boolean) => { socket.destroy(); resolve(refused); };
      socket.once("connect", () => finish(false));
      socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ECONNREFUSED"));
      socket.setTimeout(150, () => finish(false));
    });
    if (!disconnected) return;
    const latest = fs.lstatSync(filename);
    if (latest.isSocket() && latest.ino === previous.ino && latest.dev === previous.dev &&
        latest.birthtimeMs === previous.birthtimeMs) fs.unlinkSync(filename);
  }));
}

export async function brokerHealth(options: BrokerOptions, cwd: string): Promise<unknown> {
  const record = readBrokerRecord(options.dataRoot, cwd);
  if (!record) return null;
  const client = await connectBrokerSocket(record.endpoint, record.authToken);
  try {
    return await client.rpc("broker/health");
  } finally {
    await client.close();
  }
}

export async function shutdownIdleBroker(options: BrokerOptions, cwd: string): Promise<boolean> {
  try {
    const record = readBrokerRecord(options.dataRoot, cwd);
    if (!record || !samePath(record.cwd, cwd)) return false;
    const client = await connectBrokerSocket(record.endpoint, record.authToken, 350);
    try {
      await client.rpc("broker/shutdown", { idleOnly: true }, 350);
      return true;
    } finally {
      await client.close();
    }
  } catch {
    return false;
  }
}

export async function connectAppServer(cwd: string, options?: BrokerOptions, binary?: CodexBinary) {
  if (!options || binary) return connectDirect(cwd, binary);
  try {
    const file = brokerFile(options.dataRoot, cwd);
    let record = loadOrSpawn(file, cwd, options);
    const deadline = performance.now() + 5000;
    let nextProbe = 0;
    let replacements = 0;
    while (performance.now() < deadline) {
      let client;
      try {
        client = await connectBrokerSocket(record.endpoint, record.authToken, 500);
      } catch {
        if (processPresence(record.identity) === "dead" ||
            (performance.now() >= nextProbe && Date.now() - record.identity.startedAtMs >= 250 &&
             await probeProcessIdentityAsync(record.identity) === "dead")) {
          if (++replacements > 2) break;
          record = loadOrSpawn(file, cwd, options, record);
          await pruneOrphanSockets(file, record);
        } else if (performance.now() >= nextProbe && Date.now() - record.identity.startedAtMs >= 250) {
          nextProbe = performance.now() + 1500;
        }
        await delay(75);
        continue;
      }
      try {
        await client.initialize();
        return client;
      } catch (error) {
        await client.close();
        if (error instanceof AppServerRpcError && error.rpcCode === BROKER_BUSY_RPC_CODE) break;
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof PluginError && error.code === "POLICY_VIOLATION") throw error;
    // A failed or incompatible local broker can be replaced by an isolated direct client.
  }
  return connectDirect(cwd);
}

export async function waitForBrokerRecord(file: string, marker: string): Promise<BrokerRecord> {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    const record = loadRecord(file);
    if (record?.identity.markerToken === marker && record.identity.pid === process.pid) return record;
    await delay(25);
  }
  throw new PluginError("APP_SERVER_START_FAILED", "Local broker launch record was not created");
}

export function clearBrokerRecord(file: string, marker: string): void {
  withFileLock(path.join(path.dirname(file), ".broker.lock"), () => {
    if (loadRecord(file)?.identity.markerToken === marker) fs.rmSync(file, { force: true });
  });
}

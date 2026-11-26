import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import net from "node:net";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { assertSafeOption, isSandbox, PluginError, SecretRedactor } from "../security/index.js";
import { denyServerRequest, type ApprovalEvent } from "./approval-handler.js";
import { checkCodexVersion, codexArgv, resolveSupportedCodex, type CodexBinary } from "./binary-resolver.js";
import { endpointPath } from "./broker-endpoint.js";
import { asRecord, type AppServerMethods, type RpcFailure, type RpcFrame, type RpcId } from "./protocol.js";

export const MAX_LINE_BYTES = 16 * 1024 * 1024;
export const MAX_STDERR_BYTES = 512 * 1024;
export const BROKER_BUSY_RPC_CODE = -32001;
const defaultTimeout = 15_000;
const redactor = new SecretRedactor();

export function malformed(): PluginError {
  return new PluginError("PROTOCOL_MALFORMED_RESPONSE", "Invalid or oversized App Server JSONL frame");
}

function isId(id: unknown): id is RpcId {
  return typeof id === "string" || typeof id === "number" && Number.isSafeInteger(id);
}

function parseFrame(line: Buffer): RpcFrame {
  const parsed = asRecord(JSON.parse(line.toString("utf8")));
  const method = Object.hasOwn(parsed, "method");
  const id = Object.hasOwn(parsed, "id");
  const result = Object.hasOwn(parsed, "result");
  const error = Object.hasOwn(parsed, "error");
  if ((id && !isId(parsed.id)) || (method && (typeof parsed.method !== "string" || result || error)) ||
      (!method && (!id || result === error))) throw malformed();
  if (error) {
    const failure = asRecord(parsed.error);
    if (typeof failure.code !== "number" || typeof failure.message !== "string") throw malformed();
  }
  return parsed as RpcFrame;
}

export class JsonlReader {
  private fragments: Buffer[] = [];
  private length = 0;

  push(chunk: Buffer, consume: (frame: RpcFrame) => void): void {
    for (let start = 0; start < chunk.length;) {
      const newline = chunk.indexOf(10, start);
      const fragment = chunk.subarray(start, newline < 0 ? chunk.length : newline);
      this.length += fragment.length;
      if (this.length > MAX_LINE_BYTES) throw malformed();
      if (fragment.length) this.fragments.push(fragment);
      if (newline < 0) return;
      const line = Buffer.concat(this.fragments, this.length);
      this.length = 0;
      this.fragments = [];
      if (line.length && !(line.length === 1 && line[0] === 13)) {
        let frame: RpcFrame;
        try {
          frame = parseFrame(line);
        } catch {
          throw malformed();
        }
        consume(frame);
      }
      start = newline + 1;
    }
  }
}

export function sendFrame(stream: Writable, frame: RpcFrame): void {
  const line = JSON.stringify(frame) + "\n";
  if (Buffer.byteLength(line) > MAX_LINE_BYTES + 1) throw malformed();
  if (stream.destroyed || stream.writableEnded || stream.writableLength > MAX_LINE_BYTES) {
    throw new PluginError("APP_SERVER_DISCONNECTED", "The App Server transport is closed or backlogged");
  }
  stream.write(line, "utf8");
}

export class AppServerRpcError extends Error {
  readonly rpcCode: number;
  readonly details: unknown;

  constructor(failure: RpcFailure) {
    super(redactor.text(failure.message).slice(0, 4096));
    this.rpcCode = failure.code;
    this.details = redactor.deep(failure.data);
  }
}

export const clientInfo = { name: "codex-plugin-agy", title: "Codex Plugin for Antigravity", version: "0.1.2" };
export const initializeParams = {
  clientInfo,
  capabilities: {
    experimentalApi: false, requestAttestation: false,
    optOutNotificationMethods: [
      "item/agentMessage/delta", "item/reasoning/summaryTextDelta",
      "item/reasoning/summaryPartAdded", "item/reasoning/textDelta",
    ],
  },
};

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
}

export function validateRpcPolicy(params: unknown): void {
  const options = asRecord(params);
  if (options.sandbox !== undefined && options.sandbox !== null && !isSandbox(options.sandbox)) {
    throw new PluginError("POLICY_VIOLATION", "Unsafe App Server sandbox mode");
  }
  for (const option of Object.values(asRecord(options.config))) if (typeof option === "string") assertSafeOption(option);
  const policy = asRecord(options.sandboxPolicy);
  if (options.sandboxPolicy !== undefined && options.sandboxPolicy !== null &&
      policy.type !== "readOnly" && policy.type !== "workspaceWrite") {
    throw new PluginError("POLICY_VIOLATION", "Unsafe App Server sandbox policy");
  }
}

export class AppServerClient extends EventEmitter {
  private readonly pending = new Map<RpcId, PendingRpc>();
  private readonly reader = new JsonlReader();
  private readonly output: Writable;
  private nextId = 1;
  private failure: Error | null = null;
  private stderr = Buffer.alloc(0);
  private shutdown?: Promise<void>;
  initialization: unknown;

  constructor(
    input: Readable, output: Writable, readonly transport: "direct" | "broker",
    private readonly child?: ChildProcessWithoutNullStreams, private readonly socket?: net.Socket,
  ) {
    super();
    this.output = output;
    input.on("data", (chunk: Buffer) => {
      if (this.failure) return;
      try {
        this.reader.push(chunk, frame => this.receive(frame));
      } catch (error) {
        this.disconnect(error instanceof Error ? error : malformed());
        void this.close();
      }
    });
    input.on("end", () => this.disconnect());
    input.on("close", () => this.disconnect());
    input.on("error", () => this.disconnect());
    output.on("error", () => this.disconnect());
    child?.on("error", () => this.disconnect(new PluginError("APP_SERVER_START_FAILED", "Could not spawn the Codex App Server")));
    child?.on("exit", () => this.disconnect());
    child?.stderr.on("data", (chunk: Buffer) => {
      const last = chunk.subarray(Math.max(0, chunk.length - MAX_STDERR_BYTES));
      const previous = this.stderr.subarray(Math.max(0, this.stderr.length + last.length - MAX_STDERR_BYTES));
      this.stderr = Buffer.concat([previous, last]);
    });
  }

  get alive(): boolean {
    return this.failure === null;
  }

  private disconnect(error = new PluginError("APP_SERVER_DISCONNECTED", "Codex App Server disconnected", {
    retryable: true,
    details: this.stderr.length ? { stderr: redactor.text(this.stderr.toString("utf8")).slice(-8192) } : undefined,
  }) as Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
    this.emit("disconnect", error);
  }

  private receive(frame: RpcFrame): void {
    if (frame.method !== undefined && frame.id !== undefined) {
      const decision = denyServerRequest(frame);
      sendFrame(this.output, decision.response);
      if (decision.event) this.emit("approval", redactor.deep(decision.event));
      return;
    }
    if (frame.method !== undefined) {
      if (this.transport === "broker" && frame.method === "broker/approvalDenied") {
        this.emit("approval", frame.params as ApprovalEvent);
      } else {
        this.emit("notification", frame.method, frame.params);
      }
      return;
    }
    const call = this.pending.get(frame.id!);
    if (!call) return;
    this.pending.delete(frame.id!);
    clearTimeout(call.timer);
    if (frame.error) call.reject(new AppServerRpcError(frame.error));
    else call.resolve(frame.result);
  }

  request<M extends keyof AppServerMethods>(method: M, params: AppServerMethods[M][0], timeout?: number) {
    return this.rpc(method, params, timeout) as Promise<AppServerMethods[M][1]>;
  }

  rpc(method: string, params?: unknown, timeout = defaultTimeout): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= 16) return Promise.reject(new PluginError("INTERNAL_ERROR", "Too many App Server requests in flight"));
    validateRpcPolicy(params);
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PluginError("TIMEOUT", "The App Server request timed out", { retryable: true }));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        sendFrame(this.output, { id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    sendFrame(this.output, { method, params });
  }

  async initialize(): Promise<void> {
    this.initialization = await this.rpc("initialize", initializeParams);
    this.notify("initialized", {});
  }

  close(): Promise<void> {
    return this.shutdown ??= this.closeTransport();
  }

  private async closeTransport(): Promise<void> {
    this.disconnect();
    this.stderr = Buffer.alloc(0);
    this.socket?.destroy();
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    const closed = once(child, "close").catch(() => undefined);
    await Promise.race([closed, delay(500, undefined, { ref: false })]);
    if (child.exitCode === null && child.signalCode === null) {
      // This is the launch handle, not a PID recovered from disk.
      child.kill("SIGTERM");
      await Promise.race([closed, delay(750, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }
}

export async function connectDirect(cwd: string, override?: CodexBinary): Promise<AppServerClient> {
  const binary = override ?? resolveSupportedCodex(cwd).binary;
  if (override) checkCodexVersion(override, cwd);
  const launch = codexArgv(binary, ["app-server"]);
  const child = spawn(binary.executable, launch.args, {
    cwd, shell: false, windowsHide: true, windowsVerbatimArguments: launch.windowsVerbatimArguments,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new AppServerClient(child.stdout, child.stdin, "direct", child);
  try {
    await client.initialize();
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

export async function connectBrokerSocket(endpoint: string, token: string, timeout = 1_000): Promise<AppServerClient> {
  const socket = net.createConnection(endpointPath(endpoint));
  const client = new AppServerClient(socket, socket, "broker", undefined, socket);
  try {
    await client.rpc("broker/auth", { token }, timeout);
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

import fs from "node:fs";
import net from "node:net";
import { once } from "node:events";
import { timingSafeEqual } from "node:crypto";
import { SecretRedactor } from "../security/index.js";
import { endpointPath } from "./broker-endpoint.js";
import { clearBrokerRecord, waitForBrokerRecord } from "./broker-lifecycle.js";
import { AppServerRpcError, BROKER_BUSY_RPC_CODE, connectDirect, JsonlReader, sendFrame, type AppServerClient } from "./client.js";
import { asRecord, type RpcFrame, type RpcId } from "./protocol.js";

const forwardedMethods = new Set([
  "account/read", "config/read", "model/list", "thread/start", "thread/resume", "thread/read",
  "thread/name/set", "thread/list", "turn/start", "turn/interrupt", "review/start", "windowsSandbox/readiness",
]);

async function main(file: string, marker: string, idleMs: number) {
  if (!file || !/^[a-f0-9]{32}$/.test(marker) || !Number.isFinite(idleMs) || idleMs < 250) {
    throw new Error("Invalid broker launch arguments");
  }
  const record = await waitForBrokerRecord(file, marker);
  const endpoint = endpointPath(record.endpoint);
  const clients = new Set<net.Socket>();
  const redactor = new SecretRedactor();
  const expected = Buffer.from(record.authToken, "hex");
  let lease: net.Socket | undefined;
  let upstream: AppServerClient | undefined;
  let opening: Promise<AppServerClient> | undefined;
  let closing: Promise<void> | undefined;
  let idle: NodeJS.Timeout | undefined;
  let stopping = false;
  let requests = 0;
  let activeThreadId: unknown;
  let activeTurnId: unknown;
  let generation = 0;

  function write(socket: net.Socket, frame: RpcFrame) {
    try { sendFrame(socket, frame); } catch { socket.destroy(); }
  }

  function armIdle() {
    clearTimeout(idle);
    if (!lease && !stopping) idle = setTimeout(stopOnIdleOrSignal, idleMs);
  }

  function provideAppServer() {
    if (upstream?.alive) return Promise.resolve(upstream);
    return opening ??= connectDirect(record.cwd).then(client => {
      upstream = client;
      client.on("notification", (method, params) => {
        const event = asRecord(params);
        if (method === "turn/completed" && activeThreadId === event.threadId &&
            (!activeTurnId || activeTurnId === asRecord(event.turn).id)) {
          activeThreadId = activeTurnId = undefined;
          generation++;
        }
        if (lease) write(lease, { method, params });
      });
      client.on("approval", event => {
        if (lease) write(lease, { method: "broker/approvalDenied", params: redactor.deep(event) });
      });
      client.on("disconnect", () => {
        if (upstream === client) {
          upstream = undefined;
          lease?.destroy();
        }
      });
      return client;
    }).finally(() => { opening = undefined; });
  }

  function closeAppServer() {
    const current = upstream ?? opening;
    upstream = undefined;
    if (!current) return Promise.resolve();
    return Promise.resolve(current).then(async client => {
      if (upstream === client) upstream = undefined;
      await client.close();
    }, () => {});
  }

  async function shutdown(request?: { socket: net.Socket; id: RpcId }) {
    if (stopping) return;
    stopping = true;
    clearTimeout(idle);
    server.close();
    try {
      if (record.endpoint.startsWith("unix:")) fs.rmSync(endpoint, { force: true });
      clearBrokerRecord(file, marker);
      // Retire discovery before acknowledging, without waiting for the child to exit.
      if (request) write(request.socket, { id: request.id, result: {} });
    } finally {
      for (const socket of clients) socket.end();
      await (closing ?? closeAppServer());
    }
  }

  function stopOnIdleOrSignal() {
    void shutdown().catch(error => {
      process.stderr.write(redactor.text(error instanceof Error ? error.message : "Broker shutdown failed") + "\n");
      process.exitCode = 1;
    });
  }

  async function handle(socket: net.Socket, frame: RpcFrame) {
    if (frame.id === undefined) return;
    const id = frame.id;
    const method = frame.method;
    if (method === "broker/health") {
      write(socket, { id, result: {
        ok: true, pid: process.pid, startedAtMs: record.identity.startedAtMs,
        uptimeMs: Math.floor(process.uptime() * 1000), busy: !!lease || !!closing, appServerAlive: !!upstream?.alive,
      } });
      return;
    }
    if (method === "broker/shutdown") {
      if (lease || closing || stopping) {
        write(socket, { id, error: { code: BROKER_BUSY_RPC_CODE, message: "Broker is busy" } });
      } else {
        await shutdown({ socket, id });
      }
      return;
    }
    if (method === "initialize") {
      if (lease || closing || stopping) {
        write(socket, { id, error: { code: BROKER_BUSY_RPC_CODE, message: "Broker is busy" } });
        return;
      }
      lease = socket;
      clearTimeout(idle);
      try {
        const client = await provideAppServer();
        write(socket, { id, result: client.initialization });
      } catch {
        write(socket, { id, error: { code: -32000, message: "Local broker could not start Codex App Server" } });
        socket.end();
      }
      return;
    }
    if (lease !== socket || !upstream?.alive || !method || !forwardedMethods.has(method)) {
      write(socket, { id, error: { code: -32601, message: "Unsupported or unowned broker request" } });
      return;
    }
    if (requests >= 16) {
      write(socket, { id, error: { code: BROKER_BUSY_RPC_CODE, message: "Broker request limit exceeded" } });
      return;
    }
    const startsTurn = method === "turn/start" || method === "review/start";
    if (startsTurn && activeThreadId) {
      write(socket, { id, error: { code: BROKER_BUSY_RPC_CODE, message: "Broker turn already active" } });
      return;
    }

    const turnGeneration = generation;
    if (startsTurn) {
      activeThreadId = asRecord(frame.params).threadId;
      activeTurnId = undefined;
    }
    requests++;
    try {
      const result = await upstream.rpc(method, frame.params);
      if (startsTurn && generation === turnGeneration) {
        const turn = asRecord(asRecord(result).turn);
        if (turn.status === "inProgress") activeTurnId = turn.id;
        else activeThreadId = activeTurnId = undefined;
      }
      write(socket, { id, result });
    } catch (error) {
      if (startsTurn && error instanceof AppServerRpcError && generation === turnGeneration) {
        activeThreadId = activeTurnId = undefined;
      }
      write(socket, { id, error: {
        code: error instanceof AppServerRpcError ? error.rpcCode : -32000,
        message: redactor.text(error instanceof Error ? error.message : "Local broker request failed"),
      } });
    } finally {
      requests--;
    }
  }

  const server = net.createServer(socket => {
    if (clients.size >= 16 || stopping) { socket.destroy(); return; }
    clients.add(socket);
    let authenticated = false;
    const deadline = setTimeout(() => socket.destroy(), 1000);
    const reader = new JsonlReader();
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      if (socket.destroyed) return;
      try {
        reader.push(chunk, frame => {
          if (socket.destroyed || socket.writableEnded) return;
          if (!authenticated) {
            const token = asRecord(frame.params).token;
            if (frame.method !== "broker/auth" || frame.id === undefined || typeof token !== "string" ||
                !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(expected, Buffer.from(token, "hex"))) {
              socket.destroy();
              return;
            }
            authenticated = true;
            clearTimeout(deadline);
            write(socket, { id: frame.id, result: { ok: true } });
            return;
          }
          void handle(socket, frame).catch(() => socket.destroy());
        });
      } catch {
        socket.destroy();
      }
    });
    socket.on("close", () => {
      clients.delete(socket);
      clearTimeout(deadline);
      if (lease !== socket) return;
      lease = undefined;
      if (requests || activeThreadId || opening) {
        activeThreadId = activeTurnId = undefined;
        closing = closeAppServer().finally(() => { closing = undefined; armIdle(); });
      } else {
        armIdle();
      }
    });
  });
  const listening = once(server, "listening");
  server.listen(endpoint);
  await listening;
  if (record.endpoint.startsWith("unix:")) fs.chmodSync(endpoint, 0o600);
  armIdle();
  process.once("SIGINT", stopOnIdleOrSignal);
  process.once("SIGTERM", stopOnIdleOrSignal);
}

const [, , file, marker, idle] = process.argv;
main(file, marker, Number(idle)).catch(error => {
  process.stderr.write(new SecretRedactor().text(error instanceof Error ? error.message : "Broker startup failed") + "\n");
  process.exitCode = 1;
});

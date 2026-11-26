import { Console } from "node:console";
import { format } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { clientInfo, shutdownIdleBroker } from "../app-server/index.js";
import { ConfigManager } from "../config/index.js";
import { envelope, type ToolResponseEnvelope } from "../formatting/index.js";
import { isActive, JobManager } from "../jobs/index.js";
import { canonicalDirectory, errorInfo, pathInWorkspace, PluginError, SecretRedactor } from "../security/index.js";
import { mcpShutdown, registerCore, type RegisterTool } from "./tools-core.js";
import { registerParity } from "./tools-parity.js";

interface ServerScripts { worker: string; broker: string; pluginRoot: string }

function wire(result: ToolResponseEnvelope): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: { ...result }, isError: !result.ok };
}

async function resolveWorkspace(sdk: McpServer, supplied?: string) {
  const caps = sdk.server.getClientCapabilities();
  const installed = Boolean(process.env.PLUGIN_ROOT);
  let roots: string[] = [];
  if (caps?.roots) {
    const response = await sdk.server.listRoots(undefined, { timeout: 5000 }).catch(() => undefined);
    roots = response?.roots.flatMap(root => {
      try {
        const uri = new URL(root.uri);
        if (uri.protocol !== "file:" || (uri.hostname && uri.hostname !== "localhost")) return [];
        return [canonicalDirectory(fileURLToPath(uri))];
      } catch {
        return [];
      }
    }) ?? [];
  } else if (!installed) {
    roots = [canonicalDirectory(process.cwd())];
  }
  if (!roots.length) {
    throw new PluginError("INVALID_ARGUMENTS", "No usable workspace root was supplied by the host",
      { remediation: ["Open a workspace in Antigravity before using this tool."] });
  }
  if (!supplied || !path.isAbsolute(supplied)) {
    const root = roots[0];
    return { root, cwd: supplied ? canonicalDirectory(pathInWorkspace(root, supplied)) : root };
  }
  let failure: unknown;
  for (const root of roots.sort((a, b) => b.length - a.length)) {
    try {
      return { root, cwd: canonicalDirectory(pathInWorkspace(root, supplied)) };
    } catch (error) {
      failure ??= error;
    }
  }
  throw failure;
}

export async function runMcpServer(scripts: ServerScripts): Promise<void> {
  const redact = new SecretRedactor();
  const stderr = new Console(process.stderr);
  console.log = console.info = console.debug = (...args: unknown[]) => stderr.error(redact.text(format(...args)));
  const config = new ConfigManager();
  const sdk = new McpServer({ name: clientInfo.name, version: clientInfo.version });
  let closing = false;
  const handlers = new Map<string, (input: unknown, signal?: AbortSignal) => Promise<CallToolResult>>();
  const outputSchema = z.object({
    ok: z.boolean(), pluginMeta: z.object({ tool: z.string(), schemaVersion: z.literal("1.0") }).passthrough(),
    workerOutput: z.unknown(), error: z.unknown().optional(),
  });
  const register: RegisterTool = (name, description, schema, run) => {
    const invoke = async (input: unknown, signal?: AbortSignal): Promise<CallToolResult> => {
      try {
        const bytes = Buffer.byteLength(JSON.stringify(input ?? {}));
        if (bytes > 512 * 1024) throw new PluginError("INVALID_ARGUMENTS", "Tool arguments exceed the input byte limit");
        const parsed = schema.safeParse(input ?? {});
        if (!parsed.success) {
          throw new PluginError("INVALID_ARGUMENTS", "Invalid tool arguments", {
            details: { issues: parsed.error.issues.slice(0, 12).map(issue => ({ path: issue.path.map(String), code: issue.code })) },
          });
        }
        const controller = new AbortController();
        const abort = () => queueMicrotask(() => controller.abort(closing ? mcpShutdown : signal?.reason));
        signal?.addEventListener("abort", abort, { once: true });
        try {
          if (closing || signal?.aborted) controller.abort(closing ? mcpShutdown : signal?.reason);
          return wire(await run(parsed.data, controller.signal));
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      } catch (error) {
        return wire(envelope(name, {}, null, errorInfo(error)));
      }
    };
    sdk.registerTool<typeof outputSchema, z.ZodType>(name, { description, inputSchema: schema, outputSchema },
      (args, extra) => invoke(args, extra.signal));
    handlers.set(name, invoke);
  };
  const managers = new Map<string, JobManager>();
  const directories = new Map<string, Map<string, JobManager>>();
  const touch = (cwd: string) => {
    let jobs = directories.get(cwd);
    if (!jobs) directories.set(cwd, jobs = new Map());
    return jobs;
  };
  const context = {
    runtime: { config, broker: { dataRoot: config.root, script: scripts.broker } },
    pluginRoot: scripts.pluginRoot,
    workspace: async (supplied?: string) => {
      const { root, cwd } = await resolveWorkspace(sdk, supplied);
      if (closing) throw mcpShutdown;
      touch(cwd);
      const jobs = managers.get(root) ?? new JobManager(config, root, scripts.worker, job => {
        touch(job.effectiveCwd).set(job.id, jobs);
      });
      managers.set(root, jobs);
      return { root, cwd, jobs };
    },
  };
  registerCore(register, context);
  registerParity(register, context);
  // McpServer owns discovery. Validate calls here so invalid Zod arguments
  // return the same structured envelope as runtime errors.
  sdk.server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    const name = request.params.name;
    const invoke = handlers.get(name);
    return invoke ? invoke(request.params.arguments, extra.signal) :
      wire(envelope("unknown", {}, null, errorInfo(new PluginError("INVALID_ARGUMENTS", "Unknown tool name"))));
  });
  const transport = new StdioServerTransport();
  const close = () => {
    if (closing) return;
    closing = true;
    process.stdin.removeListener("end", close);
    process.stdin.removeListener("close", close);
    void (async () => {
      await sdk.close();
      process.stdin.destroy();
      await Promise.allSettled([...directories].map(async ([cwd, jobs]) => {
        if ([...jobs].some(([id, manager]) => isActive(manager.store.get(id)?.state ?? "completed"))) return;
        // A worker can have persisted completion while its broker releases the socket.
        if (!await shutdownIdleBroker(context.runtime.broker, cwd)) {
          await delay(150);
          await shutdownIdleBroker(context.runtime.broker, cwd);
        }
      }));
    })().catch(error => stderr.error(redact.text(String(error)))).finally(() => {
      process.removeListener("SIGINT", close);
      process.removeListener("SIGTERM", close);
    });
  };
  sdk.server.onclose = close;
  process.stdin.on("end", close);
  process.stdin.on("close", close);
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  await sdk.connect(transport);
}

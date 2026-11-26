import { fileURLToPath } from "node:url";
import { runMcpServer } from "../dist/lib/mcp/server.js";
import { SecretRedactor } from "../dist/lib/security/redactor.js";

runMcpServer({
  pluginRoot: fileURLToPath(new URL("../", import.meta.url)),
  worker: fileURLToPath(new URL("./task-worker.mjs", import.meta.url)),
  broker: fileURLToPath(new URL("./app-server-broker.mjs", import.meta.url)),
}).catch(error => {
  process.stderr.write(new SecretRedactor().text(error instanceof Error ? error.message : "MCP server failed") + "\n");
  process.exitCode = 1;
});

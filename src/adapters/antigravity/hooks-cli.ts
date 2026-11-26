import { ConfigManager } from "../../config/index.js";
import { SecretRedactor } from "../../security/index.js";
import { hookWorkspace, sessionStart } from "./session-hook.js";
import { reviewGate } from "./review-gate.js";
import { hookInput, type StopOutput } from "./types.js";

export async function runHookCli(pluginRoot: string, worker: string) {
  const redactor = new SecretRedactor();
  const warning = (message: string) => process.stderr.write(redactor.text(message) + "\n");
  let output: StopOutput = {};
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const event = process.argv[2];
    if (process.env.CODEX_PLUGIN_AGY_IN_HOOK !== "1" && (event === "SessionStart" || event === "Stop")) {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of process.stdin) {
        length += chunk.length;
        if (length > 256 * 1024) throw new Error("Hook input size limit exceeded");
        chunks.push(chunk);
      }
      const input = hookInput(JSON.parse(Buffer.concat(chunks).toString("utf8")), event);
      const { root, cwd } = hookWorkspace(input);
      const config = new ConfigManager();
      if (event === "SessionStart") sessionStart(config, root, cwd, input);
      else output = await reviewGate({ config, pluginRoot, worker, warning }, root, cwd, input, controller.signal);
    }
  } catch (error) {
    warning(error instanceof Error && error.name === "PluginError" ? error.message : "Unable to read Antigravity hook input");
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
  process.stdout.write(JSON.stringify(output) + "\n");
}

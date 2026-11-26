import { fileURLToPath } from "node:url";
import { runHookCli } from "../dist/lib/adapters/antigravity/index.js";

await runHookCli(fileURLToPath(new URL("../", import.meta.url)), fileURLToPath(new URL("./task-worker.mjs", import.meta.url)));

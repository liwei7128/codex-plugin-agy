import { fileURLToPath } from "node:url";
import { runWorker } from "../dist/lib/jobs/task-worker.js";

runWorker(fileURLToPath(new URL("./app-server-broker.mjs", import.meta.url)));

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const result = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.json"], {
  cwd: root,
  shell: false,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

await build({
  absWorkingDir: root,
  entryPoints: ["scripts/mcp-server.mjs", "scripts/task-worker.mjs", "scripts/app-server-broker.mjs", "scripts/hooks.mjs"],
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "dist/runtime",
  outExtension: { ".js": ".mjs" },
  target: "node18.18",
  banner: { js: 'import {createRequire as bundleRequire} from "node:module"; const require = bundleRequire(import.meta.url);' },
  legalComments: "eof",
});

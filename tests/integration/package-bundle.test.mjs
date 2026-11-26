import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { clientInfo } from "../../dist/lib/app-server/client.js";

test("isolated plugin starts all ten tools using Node alone", async t => {
  const packageScript = fileURLToPath(new URL("../../scripts/package.mjs", import.meta.url));
  const packageResult = spawnSync(process.execPath, [packageScript], { shell: false, encoding: "utf8", timeout: 30000 });
  assert.equal(packageResult.status, 0, packageResult.stderr);
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ca-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const plugin = path.join(dir, "plugin with spaces");
  fs.cpSync("dist/plugin", plugin, { recursive: true });
  const version = JSON.parse(fs.readFileSync(path.join(plugin, "plugin.json"), "utf8")).version;
  assert.equal(JSON.parse(fs.readFileSync("package.json", "utf8")).version, version);
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  assert.equal(lock.version, version);
  assert.equal(lock.packages[""].version, version);
  assert.equal(clientInfo.version, version);
  assert.ok(!fs.existsSync(path.join(plugin, "node_modules")));
  for (let ancestor = dir; ; ancestor = path.dirname(ancestor)) {
    assert.ok(!fs.existsSync(path.join(ancestor, "node_modules")), ancestor);
    if (path.dirname(ancestor) === ancestor) break;
  }
  for (const forbidden of ["src", "AGENTS.md", "tests", "docs"]) assert.ok(!fs.existsSync(path.join(plugin, forbidden)));
  const dataRoot = path.join(dir, "data");
  const env = { ...process.env, PLUGIN_ROOT: plugin, CODEX_PLUGIN_AGY_DATA_DIR: dataRoot };
  const client = new Client({ name: "isolated-fixture", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(plugin, "scripts", "mcp-server.mjs")],
    cwd: plugin, env,
  });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().version, version);
    assert.equal((await client.listTools()).tools.length, 10);
  } finally {
    await client.close();
  }
  const hook = spawnSync(process.execPath, [path.join(plugin, "scripts", "hooks.mjs"), "Stop"], {
    shell: false, cwd: plugin, env, encoding: "utf8",
    input: JSON.stringify({ conversationId: "isolation", hookEventName: "Stop", workspacePaths: [dir], cwd: dir,
      terminationReason: "NO_TOOL_CALL", fullyIdle: true }),
  });
  assert.equal(hook.status, 0, hook.stderr);
  assert.deepEqual(JSON.parse(hook.stdout), {});
  const archive = fs.readFileSync(`dist/releases/codex-plugin-agy-${version}.zip`);
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50);
});

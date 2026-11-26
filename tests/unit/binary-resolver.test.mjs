import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codexArgv, resolveCodexBinary } from "../../dist/lib/app-server/binary-resolver.js";

test("resolve native binaries and prefer Windows .exe", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agy-bin-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const posix = path.join(root, "codex");
  const win = path.join(root, "codex.exe");
  fs.writeFileSync(posix, "", { mode: 0o700 });
  fs.writeFileSync(win, "");
  if (process.platform !== "win32") {
    assert.equal(resolveCodexBinary({ platform: process.platform, env: { PATH: root } }).executable, posix);
  }
  assert.equal(resolveCodexBinary({ platform: "win32", env: { PATH: root } }).executable, win);
});

test("resolve npm's Windows CMD shim without shell expansion", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agy-bin-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shim = path.join(root, "codex.cmd");
  const nodeScript = path.join(root, "node_modules", "@openai", "codex", "bin", "codex.js");
  fs.mkdirSync(path.dirname(nodeScript), { recursive: true });
  fs.writeFileSync(nodeScript, "");
  fs.writeFileSync(shim, "node node_modules/@openai/codex/bin/codex.js");
  const binary = resolveCodexBinary({ platform: "win32", env: { PATH: root } });
  assert.deepEqual(binary, { kind: "npm", executable: process.execPath, prefix: [nodeScript] });
  fs.writeFileSync(shim, "@echo off");
  const fallback = resolveCodexBinary({ platform: "win32", env: { PATH: root } });
  assert.equal(fallback.kind, "cmd");
  assert.equal(codexArgv(fallback, ["app-server"]).windowsVerbatimArguments, true);
  assert.throws(() => codexArgv(fallback, ["--version&echo injected"]), { code: "POLICY_VIOLATION" });
  assert.throws(() => resolveCodexBinary({ platform: "win32", env: { PATH: root, CODEX_BIN: "missing.cmd" } }),
    { code: "CODEX_NOT_INSTALLED" });
});

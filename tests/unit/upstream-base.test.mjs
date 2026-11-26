import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { parseArgs, splitRawArgumentString } from "../../src/upstream/args.mjs";
import { withFileLock, writeFileAtomic } from "../../src/upstream/fs.mjs";
import { interpolateTemplate, loadPromptTemplate } from "../../src/upstream/prompts.mjs";
import { resolveWorkspaceRoot } from "../../src/upstream/workspace.mjs";

test("parse flags and quoted arguments", () => {
  const argv = splitRawArgumentString('--cwd "a b" -- x');
  assert.deepEqual(parseArgs(argv, { valueOptions: ["cwd"] }), {
    options: { cwd: "a b" }, positionals: ["x"],
  });
});

test("load and interpolate upstream review prompt and parse its schema", () => {
  const template = loadPromptTemplate(process.cwd(), "adversarial-review");
  assert.ok(interpolateTemplate(template, { TARGET_LABEL: "example target" }).includes("example target"));
  const schema = JSON.parse(fs.readFileSync("schemas/review-output.schema.json", "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(schema.required, ["verdict", "summary", "findings", "next_steps"]);
  for (const key of schema.required) assert.ok(schema.properties[key]);
});

test("atomic writes replace complete files without leaving temporary files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agy-base-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "file.json");
  writeFileAtomic(target, '{"n":1}');
  writeFileAtomic(target, '{"n":2}');
  assert.equal(fs.readFileSync(target, "utf8"), '{"n":2}');
  const fsModule = new URL("../../src/upstream/fs.mjs", import.meta.url).href;
  await Promise.all([3, 4].map((n) => new Promise((resolve, reject) => {
    const source = `import(${JSON.stringify(fsModule)}).then(({ writeFileAtomic }) => {
      writeFileAtomic(${JSON.stringify(target)}, ${JSON.stringify(JSON.stringify({ n }))});
    }).catch(error => { throw error });`;
    const worker = new Worker(source, { eval: true });
    worker.once("error", reject);
    worker.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
  })));
  assert.ok([3, 4].includes(JSON.parse(fs.readFileSync(target, "utf8")).n));
  assert.deepEqual(fs.readdirSync(root), ["file.json"]);
});

test("resolve Git roots and non-Git working directories", (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "codex-agy-root-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(resolveWorkspaceRoot(root), root);
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: root, shell: false }).status, 0);
  const child = fs.mkdirSync(path.join(root, "child"));
  assert.equal(path.resolve(resolveWorkspaceRoot(path.join(root, "child"))), root);
});

test("recovers expired dead, empty, and interrupted recovery locks", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agy-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lock = path.join(root, "state.lock");
  const expired = new Date(Date.now() - 40_000);
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  for (const [name, owner, recovery] of [["dead", String(dead), false], ["empty", "", false], ["recovery", String(dead), true]]) {
    await t.test(name, () => {
      fs.writeFileSync(lock, owner);
      fs.utimesSync(lock, expired, expired);
      if (recovery) {
        fs.writeFileSync(lock + ".recovery", "");
        fs.utimesSync(lock + ".recovery", expired, expired);
      }
      assert.equal(withFileLock(lock, () => fs.readFileSync(lock, "utf8")), String(process.pid));
      assert.deepEqual(fs.readdirSync(root), []);
    });
  }
});

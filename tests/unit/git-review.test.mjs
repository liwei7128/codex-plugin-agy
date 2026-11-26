import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareReview } from "../../dist/lib/runtime/review.js";
import { collectReviewContext, resolveReviewTarget } from "../../src/upstream/git.mjs";

export function repository(t) {
  const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ca-")));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5 }));
  const git = (...args) => {
    const value = spawnSync("git", ["-c","user.name=Fixture","-c","user.email=fixture@example.invalid", ...args],
      { cwd, shell: false, encoding: "utf8" });
    assert.equal(value.status, 0, value.stderr);
    return value.stdout.trim();
  };
  git("init", "--quiet");
  git("symbolic-ref", "HEAD", "refs/heads/main");
  fs.writeFileSync(path.join(cwd, "a file.txt"), "initial\n");
  fs.writeFileSync(path.join(cwd, "b.txt"), "initial\n");
  git("add", "--", ".");
  git("commit", "--quiet", "-m", "initial");
  fs.writeFileSync(path.join(cwd, "a file.txt"), "staged\n");
  git("add", "--", "a file.txt");
  fs.writeFileSync(path.join(cwd, "b.txt"), "unstaged\n");
  return { cwd, git };
}

test("staged paths include exact literal Git changes; large scopes self-collect", t => {
  const { cwd } = repository(t);
  const result = prepareReview(cwd, cwd, process.cwd(), { scope: "staged", paths: ["a file.txt"] }, false);
  assert.match(result.prompt, /\+staged/);
  assert.doesNotMatch(result.prompt, /\+unstaged/);
  const context = collectReviewContext(cwd, resolveReviewTarget(cwd), { maxInlineFiles: 0 });
  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.fileCount, 2);
});

test("native scope targets and review path security", t => {
  const { cwd, git } = repository(t);
  const plan = args => prepareReview(cwd, cwd, process.cwd(), args, false);
  assert.equal(plan({ scope: "uncommitted" }).reviewTarget.type, "uncommittedChanges");
  assert.deepEqual(plan({ scope: "branch", base: "main" }).reviewTarget, { type: "baseBranch", branch: "main" });
  assert.equal(plan({ commit: "HEAD" }).reviewTarget.sha, git("rev-parse", "HEAD"));
  assert.equal(plan({ instructions: "Find test gaps" }).reviewTarget.type, "custom");
  assert.throws(() => plan({ commit: "missing-commit", instructions: "Find test gaps" }), { code: "INVALID_ARGUMENTS" });
  assert.match(plan({ commit: "HEAD", instructions: "Find test gaps" }).reviewTarget.instructions, new RegExp(git("rev-parse", "HEAD")));
  assert.throws(() => plan({ base: "--upload-pack=evil" }), { code: "INVALID_ARGUMENTS" });
  assert.throws(() => plan({ paths: ["../outside"] }), { code: "PATH_OUTSIDE_WORKSPACE" });
  fs.symlinkSync(os.tmpdir(), path.join(cwd, "escaped"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => plan({ paths: ["escaped"] }), { code: "SYMLINK_ESCAPE" });
});

test("branch review enumerates literal paths that contain spaces and non-ASCII text", t => {
  const { cwd, git } = repository(t);
  git("switch", "-c", "fixture-branch");
  const name = "日本語 path.txt";
  fs.writeFileSync(path.join(cwd, name), "branch fixture\n");
  git("add", "--", name);
  git("commit", "-m", "branch fixture");
  const target = resolveReviewTarget(cwd, { scope: "branch", base: "main" });
  const result = collectReviewContext(cwd, target, { maxInlineFiles: 0 });
  assert.deepEqual(result.changedFiles, ["a file.txt", name]);
  assert.ok(result.content.includes(name));
});

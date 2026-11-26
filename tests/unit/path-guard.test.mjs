import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { auditAllowedPaths, pathInWorkspace, validateGitRef } from "../../dist/lib/security/path-guard.js";

test("reject traversal, external paths and escaping symlinks; accept missing descendants", t => {
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "codex-agy-path-")));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, "workspace");
  const outside = path.join(temp, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  for (const value of ["../outside", "src/../file", outside, "src\0x"]) {
    assert.throws(() => pathInWorkspace(root, value, true), { code: "PATH_OUTSIDE_WORKSPACE" });
  }
  assert.throws(() => pathInWorkspace(root, "escape/new.txt", true), { code: "SYMLINK_ESCAPE" });
  assert.equal(pathInWorkspace(root, "src/new.txt", true), path.join(root, "src", "new.txt"));
  assert.deepEqual(auditAllowedPaths(root, ["src"], ["src/a", "src-other", "escape/x"]), ["src-other", "escape/x"]);
});

test("git refs reject flags, whitespace, revisions and metacharacters", () => {
  for (const value of ["--upload-pack=evil", ";whoami", "$(id)", "branch..other", "branch two", "HEAD~1"]) {
    assert.throws(() => validateGitRef(value), { code: "INVALID_ARGUMENTS" });
  }
  assert.equal(validateGitRef("feature/topic-1"), "feature/topic-1");
});

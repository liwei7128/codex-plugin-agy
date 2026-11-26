import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { spawnSync } from "node:child_process";

// [codex-plugin-agy] Keep the upstream Git runner shell-free without its host process helper.
function runCommand(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    timeout: 10_000,
    shell: false,
    windowsHide: true,
  });
  return { ...result, command, args, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function formatCommandFailure(result) {
  return result.stderr.trim() || result.stdout.trim() || "Git exited with status " + result.status;
}

function runCommandChecked(command, args, options) {
  const result = runCommand(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(formatCommandFailure(result));
  return result;
}

const MAX_UNTRACKED_BYTES = 24 * 1024;
const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;

// Git is directly executable on Windows. Repository-derived arguments must never pass through a shell.
function git(cwd, args, options = {}) {
  return runCommand("git", gitArgs(args), { cwd, ...options, shell: false });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", gitArgs(args), { cwd, ...options, shell: false });
}

// [codex-plugin-agy] Review arguments are literal and never use external diff filters.
function gitArgs(args) {
  return ["-c", "core.fsmonitor=false", "--no-pager", "--literal-pathspecs",
    ...args.flatMap((arg, index) => arg === "diff" && index === 0 ? [arg, "--no-ext-diff", "--no-textconv"] : [arg])];
}

function checkedRef(ref) {
  if (typeof ref !== "string" || !/^[A-Za-z0-9_.][A-Za-z0-9_./-]{0,254}$/.test(ref) ||
      ref.includes("..") || ref.includes("//") || ref.endsWith("/")) {
    throw new Error("Invalid Git reference");
  }
  return ref;
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeMaxInlineFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_FILES;
  }
  return Math.floor(parsed);
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function measureGitOutputBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return maxBytes + 1;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8");
}

function measureCombinedGitOutputBytes(cwd, argSets, maxBytes) {
  let totalBytes = 0;
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes;
    if (remainingBytes < 0) {
      return maxBytes + 1;
    }
    totalBytes += measureGitOutputBytes(cwd, args, remainingBytes);
    if (totalBytes > maxBytes) {
      return totalBytes;
    }
  }
  return totalBytes;
}

function buildBranchComparison(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", checkedRef(baseRef)]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`
  };
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd, paths = []) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only", "-z", "--", ...paths]).stdout.split("\0").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only", "-z", "--", ...paths]).stdout.split("\0").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths]).stdout.split("\0").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base == null ? null : checkedRef(options.base);
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function formatUntrackedFile(cwd, relativePath) {
  // [codex-plugin-agy] Skip links and common local credential files.
  if (/(?:^|[\\/])(?:\.env(?:\.[^\\/]+)?|auth\.json|\.git-credentials|\.netrc|id_rsa|id_ed25519)$/i.test(relativePath)) {
    return "### " + relativePath + "\n(skipped: local credential file)";
  }
  const absolutePath = path.join(cwd, relativePath);
  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
    const relative = path.relative(fs.realpathSync.native(cwd), fs.realpathSync.native(absolutePath));
    if (!stat.isFile() || path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) {
      return "### " + relativePath + "\n(skipped: link or nonregular file)";
    }
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (stat.isDirectory()) {
    return `### ${relativePath}\n(skipped: directory)`;
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

function collectWorkingTreeContext(cwd, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);

  let parts;
  if (includeDiff) {
    const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const unstagedDiff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const untrackedBody = state.untracked.slice(0, DEFAULT_INLINE_DIFF_MAX_FILES).map((file) => formatUntrackedFile(cwd, file)).join("\n\n");
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untrackedBody)
    ];
  } else {
    const stagedStat = gitChecked(cwd, ["diff", "--shortstat", "--cached"]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--shortstat"]).stdout.trim();
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff Stat", stagedStat),
      formatSection("Unstaged Diff Stat", unstagedStat),
      formatSection("Changed Files", changedFiles.slice(0, 200).join("\n"))
    ];
  }

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles
  };
}

function collectBranchContext(cwd, baseRef, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const comparison = options.comparison ?? buildBranchComparison(cwd, baseRef);
  const currentBranch = getCurrentBranch(cwd);
  // [codex-plugin-agy] Use literal UTF-8 paths regardless of Git's quoting configuration.
  const changedFiles = gitChecked(cwd, ["diff", "--name-only", "-z", comparison.commitRange, "--"]).stdout.split("\0").filter(Boolean);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", comparison.commitRange]).stdout.trim();

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: includeDiff
      ? [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Branch Diff",
            gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange]).stdout
          )
        ].join("\n")
      : [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.join("\n"))
        ].join("\n"),
    changedFiles,
    comparison
  };
}

function buildAdversarialCollectionGuidance(options = {}) {
  if (options.includeDiff !== false) {
    return "Use the repository context below as primary evidence.";
  }

  return "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings.";
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const maxInlineFiles = normalizeMaxInlineFiles(options.maxInlineFiles);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  let details;
  let includeDiff;
  let diffBytes;

  if (target.mode === "staged" || target.mode === "commit" || options.paths?.length) {
    return collectScopedContext(repoRoot, currentBranch, target, options, maxInlineFiles, maxInlineDiffBytes);
  }
  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    diffBytes = measureCombinedGitOutputBytes(
      repoRoot,
      [
        ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
        ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]
      ],
      maxInlineDiffBytes
    );
    includeDiff =
      options.includeDiff ??
      (listUniqueFiles(state.staged, state.unstaged, state.untracked).length <= maxInlineFiles &&
        diffBytes <= maxInlineDiffBytes);
    details = collectWorkingTreeContext(repoRoot, state, { includeDiff });
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef);
    const fileCount = gitChecked(repoRoot, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean).length;
    diffBytes = measureGitOutputBytes(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? (fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    details = collectBranchContext(repoRoot, target.baseRef, { includeDiff, comparison });
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    collectionGuidance: buildAdversarialCollectionGuidance({ includeDiff }),
    ...details
  };
}

// [codex-plugin-agy] Staged, commit and path-filtered scopes use the same bounds and evidence model.
export function resolveCommit(cwd, ref) {
  const sha = gitChecked(cwd, ["rev-parse", "--verify", "--end-of-options", checkedRef(ref) + "^{commit}"]).stdout.trim();
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error("Git did not return a valid commit ID");
  return sha;
}

function collectScopedContext(cwd, branch, target, options, maxFiles, maxBytes) {
  const paths = options.paths ?? [];
  const pathspecs = ["--", ...paths];
  const base = ["diff", "--no-color", "--binary"];
  const show = ["show", "--no-color", "--binary", "--no-ext-diff", "--no-textconv", "--format=short"];
  let commands;
  let changes;
  let untracked = [];
  if (target.mode === "commit") {
    const sha = resolveCommit(cwd, target.sha);
    commands = [[...show, sha, ...pathspecs]];
    changes = gitChecked(cwd, ["show", "--format=", "--name-only", "-z", sha, ...pathspecs]).stdout.split("\0").filter(Boolean);
  } else if (target.mode === "branch") {
    const range = buildBranchComparison(cwd, target.baseRef).commitRange;
    commands = [[...base, range, ...pathspecs]];
    changes = gitChecked(cwd, ["diff", "--name-only", "-z", range, ...pathspecs]).stdout.split("\0").filter(Boolean);
  } else {
    const state = getWorkingTreeState(cwd, paths);
    untracked = target.mode === "staged" ? [] : state.untracked;
    changes = target.mode === "staged" ? state.staged : listUniqueFiles(state.staged, state.unstaged, untracked);
    commands = [[...base, "--cached", ...pathspecs]];
    if (target.mode !== "staged") commands.push([...base, ...pathspecs]);
  }
  const diffBytes = measureCombinedGitOutputBytes(cwd, commands, maxBytes);
  const inline = changes.length <= maxFiles && diffBytes <= maxBytes && options.includeDiff !== false;
  const summary = "Reviewing " + changes.length + " changed file(s) in " + target.label + ".";
  return {
    cwd, repoRoot: cwd, branch, target, fileCount: changes.length, diffBytes,
    changedFiles: changes, summary, inputMode: inline ? "inline-diff" : "self-collect",
    content: inline ? [...commands.map(args => gitChecked(cwd, args).stdout), ...untracked.map(file => formatUntrackedFile(cwd, file))].join("\n")
      : formatSection("Changed Files", changes.slice(0, 200).join("\n")),
    collectionGuidance: buildAdversarialCollectionGuidance({ includeDiff: inline }) +
      " Limit inspection to this Git scope. Read-only Git argument lists: " + JSON.stringify(commands),
  };
}

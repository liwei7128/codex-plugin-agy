# AGENTS.md — Contributor & Coding-Agent Operating Guide

> **Scope Note**: Antigravity's native plugin loader ignores `AGENTS.md` at the repository root and loads end-user plugin rules exclusively from [`rules/AGENTS.md`](rules/AGENTS.md). This root `AGENTS.md` governs **developers and coding agents (Gemini 4 Neon & GPT-6.2 Sol)** building and maintaining `codex-plugin-agy`.

---

## 1. Mission & Agent Role Split

`codex-plugin-agy` is an **unofficial, Apache-2.0 community port and extension** of OpenAI's [`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) (pinned at `v1.0.6` / `db52e28f4d9ded852ab3942cea316258ae4ef346`) for **Google Antigravity**. It integrates the local official **OpenAI Codex App Server** as an autonomous worker runtime exposed via an **Antigravity Native Plugin + stdio MCP Server**.

- **Orchestrator (Gemini 4 Neon)**: Owns architecture, work-package decomposition, dispatch, independent diff/test verification, integration, and acceptance.
- **Worker (GPT-6.2 Sol in Codex)**: Owns bounded implementation, bug fixes, test authoring, and code reviews strictly within the assigned Work Package scope.

---

## 2. Authoritative Project Blueprints (Read Before Editing)

Before modifying code, read the relevant sections of these authoritative documents in order:

1. `SPEC.md` — Project requirements and acceptance criteria (`AC-01`..`AC-15`).
2. `docs/upstream-audit.md` — Verified `codex-plugin-cc@db52e28` audit, live `codex-cli 0.172.0` App Server protocol truths, Antigravity Schema v1 truths, and upstream defect list (`AUD-01`..`AUD-12`).
3. `docs/porting-matrix.md` — Exact `Reused` / `Adapted` / `Reimplemented` / `Unsupported` / `Deferred` classification per file and feature.
4. `docs/architecture.md` — Layered dependency DAG, module contracts, 10-state job FSM, 10-tool MCP interface, and packaging design.
5. `docs/security-model.md` — Threat model, monotonic security rules, fail-closed approval protocol, redaction spec, and negative test checklist.
6. `docs/implementation-plan.md` — Bounded Work Packages (`WP-01`..`WP-12`) with permitted modification scopes and test gates.

Never guess APIs, RPC methods, hook payloads, or manifest fields from memory — verify against these docs, generated protocol types (`.generated/app-server-types/`), and live CLI output.

---

## 3. Architecture & Upstream-First Rules

1. **Prioritize Upstream Reuse**: Keep audited, host-agnostic upstream code isolated under `src/upstream/`, `prompts/`, and `schemas/` with minimal, clearly commented `// [codex-plugin-agy]` edits so future `openai/codex-plugin-cc` updates sync cleanly.
2. **Strict Layered DAG**: Core runtime modules (`src/upstream/`, `src/security/`, `src/config/`, `src/app-server/`, `src/runtime/`, `src/workspace/`, `src/sessions/`, `src/jobs/`, `src/formatting/`, `src/diagnostics/`) MUST NEVER import from `@modelcontextprotocol/sdk`, `src/mcp/`, or `src/adapters/antigravity/`.
3. **Zero Claude Code Leakage**: Do NOT introduce `.claude-plugin/`, `commands/`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_ENV_FILE`, `claude_code_codex_plugin`, or `/codex:*` command syntax anywhere in the codebase.
4. **No Empty Placeholders**: Never create stub modules, placeholder implementations, fake MCP responses, or mock production runtimes.

---

## 4. Verified Protocol & Host Invariants

### Codex App Server (`>= 0.172.0`)
- **Wire Format**: Newline-delimited JSON-RPC (JSONL) over stdio / local broker socket (`initialize` -> `initialized`). Enforce `16 MiB` max line cap and `512 KiB` stderr cap.
- **Identity**: Send `clientInfo: { name: "codex-plugin-agy", title: "Codex Plugin for Antigravity", version }` and `serviceName: "antigravity_codex_plugin"`.
- **Model & Effort Validation**: Default model is `gpt-6.2-sol`, default effort is `high`. Validate `(model, reasoning_effort)` dynamically against `model/list` (`gpt-6.2-sol` supports `low`, `medium`, `high`, `xhigh`, `max`, `ultra` — do NOT hardcode upstream's outdated 6-value set). **NEVER silently fall back to another model.**
- **Review Protocol**: Always `sandbox: "read-only"`. Native `review/start` uses `delivery: "inline"` (only valid value in `0.172.0`) and supports 4 `ReviewTarget` variants (`uncommittedChanges`, `baseBranch`, `commit`, `custom`).
- **Telemetry Honesty**: Report `tokenUsage` ONLY when received via `thread/tokenUsage/updated` (otherwise `null`); report `effectiveModel` and any `model/rerouted` notification faithfully. Never fabricate runtime data.

### Google Antigravity Native Plugin (Schema v1)
- **Manifest (`plugin.json`)**: Root-level, strictly conforms to `https://antigravity.google/schemas/v1/plugin.json` (`additionalProperties: false`, `repository` MUST be a string, `logo` relative `.svg`/`.png`/`.jpg`/`.jpeg`/`.webp`, `suggestedPrompts` max 3).
- **MCP (`mcp_config.json`)**: Uses `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` in `args`/`env` (do NOT duplicate `PLUGIN_ROOT` or `PLUGIN_DATA` as env keys). `process.stdout` of the MCP server is **exclusively** for MCP JSON-RPC frames — redirect all logs to `stderr` or log files. The installed server starts in the plugin directory. Use canonical workspace roots from MCP `roots/list` to resolve tool `cwd`.
- **Hooks (`hooks.json`)**: Root-level, named top-level hook groups, flat handler arrays for `SessionStart` and `Stop`, relative script paths (`node ./scripts/hooks.mjs ...` — do NOT use `${PLUGIN_ROOT}` in hook `command` strings), camelCase stdin payloads, `Stop` stdout returns `{"decision": "continue", "reason": "..."}` or `{}`. Note: Antigravity has **no `SessionEnd` hook**. Validate `hookEventName` when present and resolve the workspace from payload `cwd` and `workspacePaths`. Use `executionNum` as well as `continuationActive` for the Stop iteration cap.
- **Skills (`skills/<name>/SKILL.md`)**: Frontmatter `name` MUST exactly match `<name>` directory name.
- **Rules**: End-user always-on rules go in `rules/AGENTS.md` (plain markdown, no frontmatter, `< 4 KB`, strictly non-takeover); opt-in rules go in `rules/<name>.md` with valid `trigger` frontmatter (`globs` as comma-separated string, never YAML array).
- **Validation CLI**: Use `agy 1.5.17` as the primary host baseline. Run `agy plugin validate .` and `agy plugin validate ./dist/plugin --strict --json`. Keep the target first for older versions. See [the Phase 0.5 host compatibility delta](docs/host-compatibility-delta.md).
- **Distribution**: `npm run package` must produce a zero-`node_modules` self-contained `dist/plugin/` bundle via `esbuild`. Never assume Antigravity runs `npm install`. Never auto-publish to GitHub or Marketplace.

---

## 5. Non-Negotiable Security Red Lines

Every agent working on this repository MUST uphold all 10 invariants:

1. **No Unsafe Sandbox / Bypass Flags**: Permanently forbid `danger-full-access`, `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`, and `--approve-for-me`.
2. **Monotonic Security Policy**: Plugin defaults or tool arguments may tighten, NEVER weaken, a user's Codex `sandbox_mode`, `approval_policy`, or `network_access` setting.
3. **Zero Credential Access**: Never read, copy, parse, log, or transmit `~/.codex/auth.json`, OAuth tokens, refresh tokens, or API keys. Never add telemetry.
4. **Fail-Closed Approvals**: Never return `"accept"` to Codex `ServerRequest` approvals in MCP mode; respond fail-closed (`"cancel"` / empty grant), transition job to `awaiting_approval`, and return `codex resume <threadId>`.
5. **No Command Injection / No Windows `shell: true`**: Keep `shell: false` on all `git` and binary spawns; resolve Windows `codex.exe` or npm `codex.js` via `process.execPath` (zero Node 24 `DEP0190`); reject git refs starting with `-`; pass `--` before pathspecs.
6. **Strict Path & Symlink Containment**: Canonicalize all paths with `fs.realpathSync.native` and reject `..` traversal, external paths, symlink escapes, and cross-workspace `thread_id` resumes. Always label `allowed_paths` honestly as a task-scope prompt + post-run audit, NEVER an OS sandbox boundary.
7. **Authenticated Isolated Broker**: Unix sockets live in `0o700` `${PLUGIN_DATA}/run/` (`0o600` socket); Windows named pipes use random hex names; every broker connection MUST authenticate with `broker/auth` before RPC forwarding.
8. **Verified Process Identity**: Never call `kill` or `taskkill` on an unverified raw PID; always verify `{ pid, startedAtMs, markerToken, executable }` first.
9. **Deterministic Secret Redaction & Bounded Output**: Run `SecretRedactor` on all stderr, job logs, errors, and MCP responses before persisting or returning; separate `pluginMeta` from untrusted `workerOutput`; enforce response byte caps and pagination.
10. **Safe Git & Anti-Recursion**: Never discard uncommitted user edits or run destructive git commands (`reset --hard`, `clean -fd`, `checkout --`, auto-commit/merge/push/branch-delete). Review Gate defaults OFF and enforces all 5 anti-recursion circuit breakers.

---

## 6. Coding, Cross-Platform & Testing Standards

- **Language & Modules**: TypeScript (strict mode) in `src/` + vendored ESM `.mjs` in `src/upstream/`, targeting Node.js `>= 20` (compatible floor `>= 18.18.0`). Keep external dependencies minimal.
- **Cross-Platform**: Support macOS, Linux, and Windows using cross-platform Node APIs (`node:path`, `node:fs`, `node:child_process`). Never rely on Bash or PowerShell for core runtime behavior. Handle spaces in paths, UTF-8, `\r\n` vs `\n`, and Windows atomic-rename retries (`EPERM`/`EBUSY`).
- **Atomic Persistence**: All JSON state files (`state.json`, `jobs/<id>.json`, `sessions.json`, `broker.json`, `config.json`) MUST use lockfile serialization + temp-file + `fsync` + `rename` (`writeFileAtomic`) and CAS state transitions.
- **Testing Framework**: Node built-in test runner (`node --test`) + `node:assert/strict`. No heavy test frameworks.
- **Honest Verification Reporting**: Always distinguish `Unit tested`, `Integration tested`, `Mock tested`, `Real runtime tested`, `Host tested`, and `Not verified`. Never fabricate or overstate test results.

---

## 7. Work Package Execution Protocol (For GPT-6.2 Sol Workers)

When assigned a Work Package (`WP-XX` from `docs/implementation-plan.md`):

1. **Stay Strictly Within Scope**: Only create or modify files listed in `WP-XX`'s **Permitted Modification Scope**. If an interface change outside scope is required, stop and report the exact blocker to Neon instead of editing out-of-scope files.
2. **Run Required Verification Before Completing**: Execute `npm run typecheck`, every required `node --test ...` command, and `agy plugin validate` (when applicable). Fix all failures before reporting completion.
3. **Structured Handoff Report**: End every completed WP with:
   - Files created/modified (relative paths)
   - Summary of changes mapped to the WP's Acceptance Criteria
   - Exact verification commands run and observed pass/fail counts
   - Any open issues, assumptions, or out-of-scope follow-ups
4. **Licensing Discipline**: Preserve Apache-2.0 headers/attribution on all files derived from `openai/codex-plugin-cc` and keep `UPSTREAM.md` and `NOTICE` accurate.

# Verification report

## Phase 6 release candidate

The 0.1.1 candidate was first tested on Windows and WSL 2 after the 0.1.0 review. Windows passed 72 automated checks with two skips, and WSL 2 passed 73 with one skip. Both had zero failures. The Windows live Codex smoke passed 1/1 through direct packaged MCP. Antigravity CLI 1.5.18 strictly validated the directory and ZIP with zero findings. The Windows and WSL 2 builds each reproduced candidate SHA-256 `99ee61c15b967d835c1fd2d491113b206d6745300aa758499a97a37afb9531c4`.

For `AC-07`, the candidate adds deterministic evidence for the cancel-versus-complete race, worker identity and lease retention, terminal conflict calculation, and auto-shutdown. Live cancellation was acknowledged and the idle broker exited after packaged MCP EOF. The subsequent independent re-verification kept `AC-07` partial because of two remaining job and broker lifecycle issues.

## Independent and host verification for 0.1.1

Independent re-verification on Windows passed 72 automated tests, skipped two, and passed the standalone package test. The [host acceptance report](host-acceptance-report.md) records ten authenticated Antigravity CLI 1.5.18 scenarios on Windows, including plugin discovery, delegation, cancellation, thread resume, and the Review Gate. The Antigravity App Language Server discovered the plugin. Interactive App and IDE sessions, live Linux execution, and macOS remained unverified.

### Known limitations

- **`NEW-01`** A job can stay `running` and retain its workspace write lock if the operating system reuses a crashed worker’s PID. Use `codex_cancel` to release a job stuck in this state.
- **`NEW-02`** A broker cleanup race caused the POSIX shutdown test to fail in two of six WSL 2 runs during re-verification.
- **`NEW-03`** The Simplified Chinese README lacks the note on relative Git revisions in read-only reviews.
- **`NEW-04`** A completed job can retain `finalizing` in its phase field.

## Original 0.1.0 implementation verification

Implementation verification was performed on Windows with Node.js 24.16.0, npm 11.13.0, Codex CLI 0.172.0, and Antigravity CLI 1.5.17. The live test used the packaged plugin and the existing Codex sign-in in a temporary Git repository.

## Commands and results

| Command or probe | Classification | Observed result |
| --- | --- | --- |
| `npm ci --no-audit --no-fund` | Build verification | Installed 100 packages, exit 0. |
| `npm run generate:protocol` | Protocol verification | Generated the Codex 0.172.0 bindings. The implementation uses a curated subset of the wire contracts. |
| `npm run typecheck`; `npm run build` | Build verification | Exit 0 for the strict TypeScript project and vendored JavaScript checks. |
| `npm test` on Windows | Unit tested, Integration tested, Mock tested | 55 passed, 0 failed, 1 opt-in live test skipped by default. |
| `node --test --test-concurrency=1 --test-reporter=spec` on Linux under WSL 2 | Unit tested, Integration tested, Mock tested | 55 passed, 0 failed, 1 opt-in live test skipped. Linux Node 22.23.5 and Git 2.25.1. Install, type check, build, and package passed. |
| `npm run test:package` | Integration tested | 1 passed. The isolated bundle with no ancestor `node_modules` reported all ten tools. The bundled default-off Stop hook returned `{}`. |
| `npm run package` | Build verification | Built `dist/plugin/` and `dist/releases/codex-plugin-agy-0.1.0.zip`. |
| `agy plugin validate .` | Host tested | Exit 0. One expected warning for the contributor guide at the repo root. Ten skills, two rules, one MCP server, and one hook group. |
| `agy plugin validate ./dist/plugin --strict --json` | Host tested | Exit 0, zero findings. |
| `agy plugin validate ./dist/releases/codex-plugin-agy-0.1.0.zip --strict --json` | Host tested | Exit 0, zero findings. |
| `agy plugin install <absolute path to dist/plugin>`, `agy plugin list --json`, `agy --print /skills --output-format json` | Host tested | In a temporary Windows profile the plugin was enabled, all ten skills were visible, and all ten tools appeared in the host's schema cache. The skill probe used zero model turns. |
| `CODEX_PLUGIN_AGY_RUN_LIVE_SMOKE=1 node --test tests/e2e/real-runtime-smoke.test.mjs` | Real runtime tested | 1 passed. Verified existing ChatGPT login, `gpt-6.2-sol` access and high effort availability, background status and result, read-only analysis, persisted resume, an authorized file write, acknowledged turn interruption, and native read-only review. The test used low effort for the actual turns. |

The unqualified shell `codex --version` initially showed 0.172.0 while the native Windows executable resolver found a 0.171.0 desktop prerelease first. The resolver now enforces the minimum version, then checks the official npm installation if the preferred Windows executable is too old. The successful live smoke used the corrected resolver without a `CODEX_BIN` override.

The installed Antigravity CLI updated to 1.5.18 during verification. The final package directory, ZIP and isolated install were checked with a temporary copy of the exact 1.5.17 executable as shown by its `--version` output. Strict directory and ZIP validation also passed on 1.5.18.

## Acceptance criteria

| ID | Status and evidence |
| --- | --- |
| AC-01 | **Host tested.** Schema v1 directory and ZIP validation passed. Actual packaged plugin installed and listed as enabled in the temporary CLI profile. |
| AC-02 | **Host tested, Integration tested.** All 10 tool schemas were observed in the installed Antigravity CLI cache. The isolated stdio package test negotiated MCP initialization and listed all 10. |
| AC-03 | **Real runtime tested, Mock tested.** The packaged MCP server delegated a real task to Codex. Live Neon initiating that task is **Not verified**. |
| AC-04 | **Real runtime tested, Unit tested.** Setup checked exact `gpt-6.2-sol` access and effort catalog. Live job reported that effective model. Missing models and unsupported effort returned typed errors in tests. |
| AC-05 | **Real runtime tested, Mock tested.** The live CLI reused existing ChatGPT authentication. API-key and no-auth custom-provider diagnostics were exercised only with the mock. |
| AC-06 | **Real runtime tested, Integration tested.** Live read-only analysis returned the fixture value. A separate authorized write created only the intended smoke file. Worktree and path guards have dedicated tests. |
| AC-07 | **Real runtime tested, Integration tested.** Detached status and result retrieval and live acknowledged interruption passed. Both transport paths, timeouts, and process-death recovery passed against Mock App Server. |
| AC-08 | **Real runtime tested, Integration tested.** A real persistent thread resumed with the same identifier. Tests cover binding, cross-workspace denial, and explicit handoff. |
| AC-09 | **Real runtime tested, Mock tested.** Native inline read-only review completed with Codex. Staged/path-filter alternatives, four native targets, and structured adversarial parsing were exercised against the mock and temporary Git repositories. |
| AC-10 | **Unit tested, Mock tested.** Test cases cover missing auth, unsupported models, malformed frames, runtime errors, timeout, broker loss, and dead-worker recovery. |
| AC-11 | **Unit tested, Integration tested, Mock tested.** Monotonic policies, unsafe option rejection, approval denial, PID verification, authenticated IPC, path boundaries, secret redaction, and guardrail tests passed. |
| AC-12 | **Integration tested.** Full test suite, isolated packaging, and both installation guides delivered. CI is configured for Windows, Linux, and macOS. |
| AC-13 | **Unit tested, Integration tested.** Pinned code and prompt provenance and Apache-2.0 attribution are present. The distribution includes the upstream license and preserved notice. |
| AC-14 | **Host tested, Mock tested.** Antigravity discovered the installed orchestration skill. The full skill-driven Neon plan, delegate, verify, and fix cycle is **Not verified** with a live Neon session. |
| AC-15 | **Integration tested, Host tested.** The isolated package used only its bundled code and Node. Antigravity installed it without any dependency on the upstream host. |

## Security regressions

The checklist is covered across `tests/security/security-regression.test.mjs`, `tests/unit/`, `tests/integration/`, and `tests/mcp/`. The security suite is included in the default test run.

| Control | Test evidence |
| --- | --- |
| Sandbox and flag rejection | `security-regression.test.mjs`, `security-policy.test.mjs`, `mcp-core.test.mjs` |
| Codex policy monotonicity | `security-policy.test.mjs`, `codex-runtime.test.mjs` |
| All approval responses and job pause | `app-server-transport.test.mjs`, `security-regression.test.mjs` |
| Literal Git arguments and shell-free Windows resolver | `git-review.test.mjs`, `binary-resolver.test.mjs`, live Windows launch |
| Path traversal and cross-workspace thread access | `path-guard.test.mjs`, `session-manager.test.mjs`, `security-regression.test.mjs` |
| Broker authentication and stale PID defense | `app-server-transport.test.mjs`, `background-jobs.test.mjs` |
| Nine redaction classes, persisted secrets, and metadata separation | `redactor.test.mjs`, `security-regression.test.mjs`, `result-formatter.test.mjs` |
| JSON-RPC-only stdout and protocol caps | `mcp-core.test.mjs`, `app-server-transport.test.mjs` |
| Review Gate conditions, retries, and timeout | `antigravity-hooks.test.mjs`, actual host fixture in the Phase 0.5 report |
| Concurrent writer isolation and dirty-tree preservation | `workspace-locks.test.mjs`, `worktree-parallel.test.mjs` |

## Remaining verification

- **Windows:** Unit tested, Integration tested, Mock tested, Real runtime tested, Host tested on CLI 1.5.17. See [Phase 0.5](host-compatibility-delta.md) for the host hook fixtures and exact metadata observations.
- **Linux:** Unit tested, Integration tested, Mock tested under WSL 2. Live Codex and Antigravity host execution on Linux were not verified. The first run exposed Git 2.25's lack of `git init -b` in temporary fixtures. After the fixtures used portable initialization, the complete suite passed.
- **macOS:** Not verified locally. Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run package` on macOS or inspect the CI matrix results when available.
- **Live Neon, Antigravity App, Antigravity IDE, and older CLI releases:** Not verified end to end. Install the package into the target host, open a disposable workspace, invoke setup and orchestration, delegate one small read-only task, then inspect the real job and result. Repeat with an explicitly enabled Review Gate in a disposable checkout. The current verification establishes live Codex-through-MCP and actual CLI discovery as separate checks.

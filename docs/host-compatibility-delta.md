# Antigravity 1.5.17 compatibility delta

Phase 0.5 revalidated the Antigravity boundary on Windows on 2026-11-26. The primary baseline is `agy 1.5.17` at `%LOCALAPPDATA%\agy\bin\agy.exe`. Phase 0's observations for 1.1.27 remain historical evidence. This check did not revisit Codex App Server.

## CLI and loader evidence

- `Get-Command agy -All`, `where.exe agy`, and `agy --version` resolved the same executable. `agy --help`, `agy plugin --help`, and `agy plugin validate --help` exposed plugin install, list, enable, disable, uninstall, import, link, and validation. Validation accepts directories, manifest files, archives, and documented remote targets. `--strict` fails on warnings and `--json` emits loader findings.
- `agy plugin validate <fixture> --strict --json`, `agy plugin validate --strict --json <fixture>`, and `agy plugin validate <fixture.zip> --strict --json` each exited 0 with zero findings. The legacy Schema v1 fixture discovered one MCP server, one hook group, one skill, and two rules. Adding `SessionEnd` produced an unknown-event warning and exit 1 in strict mode. The recognized events were SessionStart, PreInvocation, PostInvocation, Stop, PreToolUse, and PostToolUse.
- The fetched v1 schema still requires `name`, sets `additionalProperties: false`, requires a string `repository`, and limits `suggestedPrompts` to three. The fixture selected the Antigravity Schema v1 loader (`agentPluginsSpec: false`). Keep the native layout and `mcp_config.json` despite support for another manifest dialect.
- In an isolated Windows user profile and temporary paths containing spaces, `agy plugin list --json` was initially empty. `agy plugin install <fixture>` installed the directory under the isolated profile's `.gemini/config/plugins/`. The subsequent list showed it enabled with all fixture components. `agy -p /skills --output-format json` listed the qualified skill name `codex-agy-phase05-probe:phase05-probe`, marked it as user-invoked, and reported zero model turns. The shell command `agy mcp list` did not list the plugin server. Use plugin inventory and an actual session to verify plugin MCP discovery. `/mcp` is interactive on this version.

[Antigravity Schema v1](https://antigravity.google/schemas/v1/plugin.json) · [Build plugins](https://antigravity.google/docs/build-plugins/) · [Plugins](https://antigravity.google/docs/plugins/) · [Skills](https://antigravity.google/docs/skills/) · [Rules](https://antigravity.google/docs/rules/)

## MCP and workspace isolation

The temporary installed fixture launched a stdio server in a real `agy` session pointed at a deterministic loopback model stub. The host sent `server/discover` and then standard `initialize` and `tools/list`. An unsupported `server/discover` response did not prevent discovery. The fixture tool appeared in the CLI schema cache under `codex-agy-phase05-probe_probe` and as an eager model declaration prefixed with `mcp_`. The server saw both injected path variables. An expanded script argument matched `PLUGIN_ROOT`, and both an expanded argument and a custom environment value matched `PLUGIN_DATA`. A separate fixture launch with explicit `cwd: "${PLUGIN_ROOT}"` also worked.

The MCP server default process directory was the **installed plugin directory**. Antigravity advertised `roots.listChanged`; `roots/list` after initialization returned the temporary workspace as its sole file root. WP-06 must use canonical MCP roots for default and supplied working directories and refresh them on calls or changes. If an installed host supplies no usable roots, report an actionable workspace error. Direct development or smoke clients without a host plugin root may use their launching workspace as the fallback anchor. Keep authentication, realpath containment, state scoping, and the distinction between task scope and sandboxing.

The docs retain 300 seconds to connect and 180 seconds per call by default. Positive `timeoutSeconds` replaces both. Keep the planned 600-second override and prefer background work when a turn may exceed it. The changelog records a structured-output context-limit fix in 1.4.1 and a lazy MCP inline limit increase from 4 KB to 10 KB in 1.4.7. Keep structured content and the JSON text copy, plus plugin-side pagination. A 16 KiB plugin page can exceed the host's inline budget, so skills should request smaller pages where necessary. Default host MCP permissions still ask; the plugin adds no permission exceptions.

[Antigravity MCP](https://antigravity.google/docs/mcp/) · [CLI permissions](https://antigravity.google/docs/cli-permissions/) · [CLI changelog](https://antigravity.google/changelog?tab=cli)

## Hook execution and Review Gate

The release notes supplied by `agy changelog` and the official changelog record `lastUserInput` in 1.4.7, plugin-hook `PLUGIN_ROOT` and `PLUGIN_DATA` in 1.5.3, `hookEventName`, payload `cwd`, and `toolCall.id` in 1.5.4, and a continuation-state field in 1.5.6. The local binary identifies as 1.5.17. Its changelog begins at 1.5.16, so runtime observations below take precedence where the text is ambiguous.

- SessionStart, PreInvocation, and Stop hook processes ran from the installed plugin directory using relative Node commands. Both plugin environment paths were set. The camelCase payload included the workspace `cwd`, `workspacePaths`, the matching `hookEventName`, and nonempty `lastUserInput` on these events. WP-10 should validate the event discriminator when present and use payload workspace information, not process cwd. Accept the absence of newly added metadata on older hosts when another verified workspace signal is available. Expected tool hook metadata includes `toolCall.id` per the 1.5.4 release notes; the local probe did not execute a matched tool callback.
- Natural Stop sent `terminationReason: "NO_TOOL_CALL"` and `fullyIdle: true`. A fixture returning `{"decision":"continue","reason":"..."}` triggered a second invocation. The second Stop increased `executionNum` from 0 to 1 but retained `continuationActive: false`. The wire key was camelCase despite the changelog spelling. The persisted cap must not reset solely on false. Use the prompt hash and execution sequence, skip recent duplicate attempts atomically, and fail open when a fresh turn cannot be distinguished safely. Never send prompt or transcript content to state logs.
- An empty object allowed Stop. A nonzero exit and a hook configured for five seconds that exceeded that timeout both let the host exit 0. The isolated CLI log recorded the hook failure. Keep the host hook's timeout above the configurable internal deadline plus bounded cleanup grace so the plugin can interrupt its own review first. Host-level Windows process-tree cleanup for a timed-out hook remains unverified.
- No session-close hook is available. Keep worker reconciliation, MCP shutdown, and broker idle expiry. The changelog reports improved Windows stdio process-tree cleanup in 1.5.1, so background survival remains conditional on what the host and OS terminate.
- The native Orchestrator remains host-managed. The release notes document Gemini 4 Neon on ADC and enterprise gateways in 1.5.13, and Orchestrator effort defaults in 1.5.15. Plugin orchestration remains opt-in guidance and MCP invocation in the current conversation.

[Antigravity hooks](https://antigravity.google/docs/hooks/) · [CLI changelog](https://antigravity.google/changelog?tab=cli) · [CLI changelog command](https://antigravity.google/docs/cli/commands/changelog/)

## Impact and remaining validation

| Package | Impact |
| --- | --- |
| WP-01–05, WP-07–08 | Keep the existing Codex, security, job, and worktree contracts. |
| WP-06 | Resolve host workspace roots through MCP and use bounded, paginated envelopes. |
| WP-09 | Keep the Schema v1 surface and test discovery against 1.5.17. Document user-invoked skills and smaller pages for on-demand results. |
| WP-10 | Validate current hook metadata, retain compatible fallbacks, and use an execution-sequence-aware Review Gate cap. |
| WP-11–12 | Validate source and the real package with 1.5.17. Strict validation applies to the package. Source validation may report the expected root contributor-guide warning. Verify installed discovery and document which runtime checks exercised actual models. |

This probe confirmed loader discovery, Windows local installation, eager MCP registration, the MCP roots boundary, and Stop behavior. The deterministic model stub did not dispatch a tool call, so host over-limit result presentation, tool-call propagation of structured results, host MCP timeout enforcement, and tool hook callback fields remain **not verified**. The App and IDE, live Neon-to-Codex delegation, packaged plugin installation, Windows detached worker survival on host quit, and a fresh rerun on agy 1.1.27 also remain **not verified**. The raw CLI switches and loader fixtures are reproducible with an isolated profile, a plugin containing the six files and directories above, and the documented loopback provider override.

[CLI authentication and endpoint override](https://antigravity.google/docs/cli/install/)

---
name: codex-delegate
description: Give local Codex a bounded engineering task and verify its result.
disable-model-invocation: false
---

Use `codex_delegate` when the user asks for Codex or enables a delegation workflow. Describe the objective, allowed editing scope, acceptance criteria, and required verification. Use read-only for analysis and request workspace-write only for authorized changes. For longer tasks request `background: true`. Poll using the returned interval, fetch `codex_result`, inspect the actual changes, and run the required tests. Treat `allowed_paths` as task guidance and a post-run audit. Codex controls the OS sandbox.

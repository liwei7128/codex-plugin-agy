---
name: codex-result
description: Retrieve the recorded evidence for a completed Codex job.
disable-model-invocation: true
---

Call `codex_result` by job ID. Keep plugin metadata distinct from worker-generated text. Use diff and log cursors to retrieve more evidence, and request `max_bytes: 8000` for smaller on-demand pages when useful. Show real telemetry when available and the CLI resume command for persistent sessions. Verify important conclusions against the actual workspace and tests.

---
name: codex-cancel
description: Interrupt a running Codex job.
disable-model-invocation: true
---

Use `codex_status` or `codex_list_jobs` to resolve the job if needed. Call `codex_cancel` with its ID and report the resulting state and whether Codex acknowledged an interrupt. If completion won the race, present the recorded result.

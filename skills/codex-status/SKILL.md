---
name: codex-status
description: Inspect a Codex job or list jobs in the current workspace.
disable-model-invocation: true
---

Call `codex_status` with the job ID. Use `codex_list_jobs` with filters or a cursor to find a job when the ID is unknown. Report its current state, latest meaningful progress, model, and next action. Honor the recommended interval for active jobs. For an approval pause, show the resume command from the job metadata.

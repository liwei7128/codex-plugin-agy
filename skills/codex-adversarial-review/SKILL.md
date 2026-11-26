---
name: codex-adversarial-review
description: Check a change for material correctness, security, and regression risks.
disable-model-invocation: false
---

Call `codex_adversarial_review` on the authorized Git scope. Use focus to identify relevant invariants such as concurrency, retries, or input validation. Present the validated findings in severity order, including affected locations, confidence, and the recommended mitigation. Surface parsing errors and bounded raw output when relevant. Stop after presenting findings and wait for the user to authorize fixes.

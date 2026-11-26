# Changelog

## 0.1.2 (release candidate)

- Reconcile dead workers and release their write leases at the recommended polling interval, even if the operating system recycles the PID.
- Remove idle broker records and close their endpoints before acknowledging shutdown.
- Persist the completed job phase and document Git revision restrictions in both languages.

## 0.1.1 (release candidate)

- Preserve paginated result evidence, completed output when cancellation races completion, and write leases during inconclusive worker probes.
- Recover stale state locks and brokers, shut down idle brokers on MCP exit, and avoid Git scans on each foreground poll.
- Restore Review Gate on later conversation turns and tighten review scope validation, approval comparison, and secret redaction.

## 0.1.0 (unreleased)

Initial Antigravity native plugin implementation. See the implementation progress and verification reports for delivery status.

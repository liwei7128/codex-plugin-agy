import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ConfigManager } from "../config/index.js";
import { captureProcessIdentity, processPresence, probeProcessIdentityAsync, terminateVerifiedProcessTree,
  type ProcessProbe } from "../runtime/index.js";
import { canonicalDirectory, errorInfo, pathInWorkspace, PluginError, SecretRedactor } from "../security/index.js";
import { SessionManager } from "../sessions/index.js";
import { writeFileAtomic } from "../upstream/fs.mjs";
import { detectConflicts, LockRegistry, planWorktree, snapshotChanges, type WorkspaceLease } from "../workspace/index.js";
import { isActive } from "./state-machine.js";
import { JobStore } from "./state-store.js";
import type { JobRecord, JobRequest, JobState } from "./types.js";

export const activeStates: readonly JobState[] = ["queued", "starting", "running", "cancelling"];
const redactor = new SecretRedactor();

export class JobManager {
  readonly workspaceRoot: string;
  readonly store: JobStore;
  readonly sessions: SessionManager;
  private readonly locks: LockRegistry;
  private readonly probes = new Map<string, { checkedAt: number; identity: string; result: ProcessProbe }>();

  constructor(readonly config: ConfigManager, workspaceRoot: string, private readonly workerScript: string,
    private readonly onJobCreated?: (job: JobRecord) => void) {
    this.workspaceRoot = canonicalDirectory(workspaceRoot);
    const settings = config.resolve(this.workspaceRoot);
    this.store = new JobStore(config.root, config.workspaceDirectory(this.workspaceRoot), settings.jobRetentionCount);
    this.sessions = new SessionManager(this.workspaceRoot, this.store.directory);
    this.locks = new LockRegistry(config.root);
  }

  create(request: JobRequest): JobRecord {
    const binding = request.threadId ? this.sessions.require(request.threadId) : null;
    const cwd = canonicalDirectory(pathInWorkspace(this.workspaceRoot, request.cwd || this.workspaceRoot));
    const settings = this.config.resolve(this.workspaceRoot, request.explicit);
    const id = randomUUID();
    if (binding && request.useWorktree) {
      throw new PluginError("INVALID_ARGUMENTS", "A persistent thread already has a bound working directory");
    }
    const worktree = request.useWorktree ? planWorktree(this.config.root, this.workspaceRoot, cwd, id) : null;
    const effectiveCwd = binding
      ? (request.cwd ? this.sessions.require(binding.threadId, cwd) : binding).cwd : worktree?.effectiveCwd ?? cwd;
    for (const entry of request.allowedPaths ?? []) {
      pathInWorkspace(worktree ? cwd : effectiveCwd, entry, true);
      if (worktree && path.isAbsolute(entry)) {
        throw new PluginError("INVALID_ARGUMENTS", "Worktree task paths must be relative");
      }
    }
    const token = randomBytes(16).toString("hex");
    const record: JobRecord = {
      id, state: "queued", workspaceRoot: this.workspaceRoot, effectiveCwd,
      request: { ...request, cwd }, launchToken: token, identity: null,
      phase: "queued", createdAt: new Date().toISOString(), startedAt: null,
      lastProgressAt: null, completedAt: null, latestProgress: null,
      requestedModel: settings.model, reasoningEffort: settings.reasoningEffort, effectiveModel: null,
      threadId: request.threadId ?? null, turnId: null, policy: null, pendingApproval: null,
      interruptAcknowledged: false, error: null, output: null,
      warnings: [], worktreePath: worktree?.worktreePath ?? binding?.worktreePath ?? null,
      worktreeBranch: worktree?.branch ?? (binding?.worktreePath ? "codex-agy/" + path.basename(binding.worktreePath) : null),
      outOfScopeFiles: [], fileConflicts: [],
    };
    for (const job of this.store.list()) this.reconcile(job);
    this.locks.reserve({
      jobId: id, workspaceRoot: this.workspaceRoot, cwd: effectiveCwd,
      sandbox: request.explicit?.sandbox ?? binding?.policy.sandbox ?? settings.sandbox,
      recordFile: this.store.file(id), reservedAtMs: Date.now(), limit: settings.maxConcurrency,
    }, lease => this.leaseActive(lease));
    try {
      this.store.create(record, settings.maxConcurrency);
    } catch (error) {
      this.locks.release(id);
      throw error;
    }
    try {
      const startedAtMs = Date.now();
      const worker = spawn(process.execPath, [this.workerScript, this.workspaceRoot, id, token], {
        cwd: this.workspaceRoot, shell: false, detached: true, stdio: "ignore", windowsHide: true,
        env: { ...process.env, CODEX_PLUGIN_AGY_DATA_DIR: this.config.root },
      });
      worker.on("error", () => this.launchFailed(id));
      worker.unref();
      if (!worker.pid) throw this.launchFailed(id);
      this.store.update(id, ["queued"], { identity: captureProcessIdentity(worker.pid, token, startedAtMs) });
      this.onJobCreated?.(record);
      return record;
    } catch {
      throw this.launchFailed(id);
    }
  }

  get(reference: string, includeConflicts = true): JobRecord {
    const record = this.reconcile((reference.length === 36 ? this.store.get(reference) : undefined) ?? this.store.resolve(reference));
    return includeConflicts ? this.withConflicts(record) : record;
  }

  private withConflicts(record: JobRecord): JobRecord {
    if (!record.worktreePath) return record;
    const others = this.store.list().filter(job => job.worktreePath && job.worktreePath !== record.worktreePath &&
      path.dirname(job.worktreePath) === path.dirname(record.worktreePath!));
    const files = snapshotChanges(record.worktreePath).keys();
    return { ...record, fileConflicts: detectConflicts(files, others.map(job => snapshotChanges(job.worktreePath!).keys())) };
  }

  list(): JobRecord[] {
    return this.store.list().map(job => this.reconcile(job));
  }

  async wait(id: string, signal?: AbortSignal): Promise<JobRecord> {
    for (;;) {
      signal?.throwIfAborted();
      const job = this.get(id, false);
      if (!isActive(job.state)) return this.withConflicts(job);
      await delay(200, undefined, { signal });
    }
  }

  async cancel(reference: string, reason?: string): Promise<JobRecord> {
    const current = this.get(reference, false);
    if (current.state === "cancelled" || current.state === "cancelling") {
      return current.state === "cancelled" ? current : this.waitForCancellation(current.id);
    }
    if (current.state === "awaiting_approval") {
      return this.store.update(current.id, ["awaiting_approval"], {
        state: "cancelled", completedAt: new Date().toISOString(),
      }) ?? this.get(current.id);
    }
    if (!isActive(current.state)) throw new PluginError("JOB_NOT_CANCELABLE", "The job already reached a terminal state");
    const job = this.store.update(current.id, ["queued", "starting", "running"], {
      state: "cancelling", latestProgress: redactor.text(reason ?? "Cancellation requested").slice(0, 1024),
    });
    if (!job) return this.get(current.id);
    try {
      writeFileAtomic(this.store.file(job.id, ".cancel"), "");
    } catch {
      // The worker also reads the persisted cancelling state.
    }
    return this.waitForCancellation(job.id);
  }

  private async waitForCancellation(id: string): Promise<JobRecord> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const job = this.store.get(id);
      if (!job) throw new PluginError("JOB_NOT_FOUND", "Job disappeared while cancelling");
      if (job.state !== "cancelling") return job;
      if (Date.now() >= deadline) {
        const probe = job.identity ? await probeProcessIdentityAsync(job.identity) : "dead";
        const latest = this.store.get(id);
        if (!latest || latest.state !== "cancelling") return latest ?? job;
        if (latest.identity?.pid !== job.identity?.pid || latest.identity?.markerToken !== job.identity?.markerToken) return latest;
        if (probe === "unknown" || (probe === "alive" && latest.phase === "finalizing")) return latest;
        const didTerminate = probe === "alive" && job.identity ? terminateVerifiedProcessTree(job.identity) : false;
        if (probe === "alive" && !didTerminate && job.identity && processPresence(job.identity) !== "dead") return latest;
        const state = didTerminate ? "cancelled" : "interrupted";
        const updated = this.store.update(id, ["cancelling"], {
          state, completedAt: new Date().toISOString(),
          error: didTerminate ? null : errorInfo(new PluginError("APP_SERVER_DISCONNECTED", "The worker exited during the cancellation grace period")),
        });
        if (updated) this.locks.release(id);
        return updated ?? this.get(id);
      }
      await delay(100);
    }
  }

  private reconcile(job: JobRecord): JobRecord {
    if (!isActive(job.state)) {
      this.probes.delete(job.id);
      return job;
    }
    if (Date.now() - Date.parse(job.createdAt) < 1500 && !job.startedAt) return job;
    if (this.probe(job) !== "dead") return job;
    this.probes.delete(job.id);
    const updated = this.store.update(job.id, [job.state], {
      state: "interrupted", completedAt: new Date().toISOString(),
      error: errorInfo(new PluginError("APP_SERVER_DISCONNECTED", "The worker process exited or its identity no longer matches")),
    });
    if (updated) this.locks.release(job.id);
    return updated ?? this.store.get(job.id) ?? job;
  }

  private leaseActive(lease: WorkspaceLease): boolean {
    try {
      const file = pathInWorkspace(this.config.root, lease.recordFile);
      const job = JSON.parse(fs.readFileSync(file, "utf8")) as JobRecord;
      if (job.id !== lease.jobId || !isActive(job.state)) return false;
      if (!job.startedAt && Date.now() - lease.reservedAtMs < 5000) return true;
      return this.probe(job) !== "dead";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() - lease.reservedAtMs < 5000;
    }
  }

  private probe(job: JobRecord): ProcessProbe {
    const identity = job.identity;
    if (!identity) return "dead";
    const presence = processPresence(identity);
    if (presence !== "alive") return presence;
    const key = JSON.stringify([identity.pid, identity.markerToken, identity.startedAtMs, identity.executable]);
    const cached = this.probes.get(job.id);
    if (cached?.identity === key && Date.now() - cached.checkedAt < 1500) return cached.result;
    const pending = { checkedAt: Infinity, identity: key, result: "unknown" as ProcessProbe };
    this.probes.set(job.id, pending);
    if (this.probes.size > 256) this.probes.delete(this.probes.keys().next().value!);
    void probeProcessIdentityAsync(identity).then(result => {
      pending.checkedAt = Date.now();
      pending.result = result;
    });
    return "unknown";
  }

  private launchFailed(id: string): PluginError {
    const error = new PluginError("APP_SERVER_START_FAILED", "Unable to launch detached Codex worker");
    this.store.update(id, ["queued"], { state: "failed", completedAt: new Date().toISOString(), error: errorInfo(error) });
    this.locks.release(id);
    return error;
  }
}

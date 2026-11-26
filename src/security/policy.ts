import { PluginError } from "./errors.js";

export type Sandbox = "read-only" | "workspace-write";
export type ApprovalName = "never" | "on-request" | "untrusted";
export type GranularApproval = { granular: Record<
  "sandbox_approval" | "rules" | "skill_approval" | "request_permissions" | "mcp_elicitations", boolean
> };
export type ApprovalPolicy = ApprovalName | GranularApproval;

export interface CodexBaseline {
  model?: string | null;
  model_reasoning_effort?: string | null;
  sandbox_mode?: string | null;
  approval_policy?: ApprovalPolicy | null;
  sandbox_workspace_write?: { network_access?: boolean } | null;
}

export interface SecurityPolicy {
  sandbox: Sandbox;
  approvalPolicy: ApprovalPolicy;
  networkAccess: boolean;
}

export function assertSafeOption(value: string): void {
  if (/^(danger-full-access|--dangerously-bypass-approvals-and-sandbox|--dangerously-bypass-hook-trust|--approve-for-me)(?:=|$)/i.test(value)) {
    throw new PluginError("POLICY_VIOLATION", "An unsafe Codex mode or flag was rejected");
  }
}

export function isSandbox(value: unknown): value is Sandbox {
  return value === "read-only" || value === "workspace-write";
}

const approvalRank = { never: 0, "on-request": 1, untrusted: 2 } as const;
const granularKeys = ["sandbox_approval", "rules", "skill_approval", "request_permissions", "mcp_elicitations"] as const;

export function isApprovalName(value: unknown): value is ApprovalName {
  return typeof value === "string" && Object.hasOwn(approvalRank, value);
}

export function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
  if (isApprovalName(value)) return true;
  if (!value || typeof value !== "object" || !("granular" in value)) return false;
  const granular = value.granular;
  return !!granular && typeof granular === "object" && Object.keys(granular).length === 5 &&
    granularKeys.every(key => typeof (granular as Record<string, unknown>)[key] === "boolean");
}

export function sameApprovalPolicy(left: ApprovalPolicy, right: ApprovalPolicy): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right;
  return granularKeys.every(key => left.granular[key] === right.granular[key]);
}

export function stricterApproval(baseline: ApprovalPolicy, requested: ApprovalPolicy): ApprovalPolicy {
  if (typeof baseline !== "string") {
    if (requested === "untrusted") {
      throw new PluginError("POLICY_VIOLATION", "Untrusted approval mode cannot preserve granular approval restrictions");
    }
    if (typeof requested === "string") return baseline;
    return { granular: {
      sandbox_approval: baseline.granular.sandbox_approval && requested.granular.sandbox_approval,
      rules: baseline.granular.rules && requested.granular.rules,
      skill_approval: baseline.granular.skill_approval && requested.granular.skill_approval,
      request_permissions: baseline.granular.request_permissions && requested.granular.request_permissions,
      mcp_elicitations: baseline.granular.mcp_elicitations && requested.granular.mcp_elicitations,
    } };
  }
  if (typeof requested !== "string") {
    throw new PluginError("POLICY_VIOLATION", "Named approval mode cannot preserve granular approval restrictions");
  }
  return approvalRank[baseline] > approvalRank[requested] ? baseline : requested;
}

export function resolvePolicy(
  baseline: CodexBaseline,
  requested: Partial<SecurityPolicy> = {},
  readOnly = false,
): SecurityPolicy {
  const sandbox = requested.sandbox ?? "read-only";
  assertSafeOption(sandbox);
  if (!isSandbox(sandbox)) throw new PluginError("POLICY_VIOLATION", "Unsupported sandbox mode");
  if (baseline.sandbox_mode != null && !isSandbox(baseline.sandbox_mode) &&
      baseline.sandbox_mode !== "danger-full-access") {
    throw new PluginError("POLICY_VIOLATION", "Unsupported Codex sandbox policy");
  }
  if (!readOnly && sandbox === "workspace-write" && baseline.sandbox_mode === "read-only") {
    throw new PluginError("POLICY_VIOLATION", "The effective Codex configuration permits only read-only access");
  }
  const userApproval = baseline.approval_policy ?? "never";
  const requestedApproval = requested.approvalPolicy ?? userApproval;
  if (!isApprovalPolicy(userApproval) || !isApprovalPolicy(requestedApproval)) {
    throw new PluginError("POLICY_VIOLATION", "Unsupported Codex approval policy");
  }
  const effectiveSandbox = readOnly ? "read-only" : sandbox;
  return {
    sandbox: effectiveSandbox,
    approvalPolicy: stricterApproval(userApproval, requestedApproval),
    networkAccess: effectiveSandbox === "workspace-write" &&
      baseline.sandbox_workspace_write?.network_access === true && requested.networkAccess !== false,
  };
}

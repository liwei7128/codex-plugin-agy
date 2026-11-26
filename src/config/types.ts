import type { ApprovalName, Sandbox } from "../security/policy.js";

export type OrchestrationMode = "assisted" | "delegated" | "review" | "parallel";
export interface ReviewGateConfig {
  enabled: boolean;
  maxRunsPerTurn: number;
  timeoutSeconds: number;
}
export interface PluginConfig {
  model: string;
  reasoningEffort: string;
  sandbox: Sandbox;
  approvalPolicy: ApprovalName;
  timeoutSeconds: number;
  maxConcurrency: number;
  jobRetentionCount: number;
  orchestrationMode: OrchestrationMode;
  reviewGate: ReviewGateConfig;
}
export type ConfigOverrides = Partial<Omit<PluginConfig, "reviewGate">> & {
  reviewGate?: Partial<ReviewGateConfig>;
};

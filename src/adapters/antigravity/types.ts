import { PluginError } from "../../security/index.js";

export type HookEvent = "SessionStart" | "Stop";
export interface HookInput {
  hookEventName?: HookEvent;
  conversationId: string;
  workspacePaths: string[];
  cwd?: string;
  modelName?: string;
  lastUserInput?: string;
  executionNum?: number;
  terminationReason?: string;
  error?: string;
  fullyIdle?: boolean;
  continuationActive?: boolean;
}
export type StopOutput = { decision?: "continue"; reason?: string };

export function hookInput(value: unknown, event: HookEvent): HookInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginError("INVALID_ARGUMENTS", "Hook input must be an object");
  }
  const data = value as Record<string, unknown>;
  if (typeof data.conversationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(data.conversationId) ||
      !Array.isArray(data.workspacePaths) || data.workspacePaths.length > 32 ||
      !data.workspacePaths.every(item => typeof item === "string" && item.length < 4096) ||
      (data.hookEventName !== undefined && data.hookEventName !== event)) {
    throw new PluginError("INVALID_ARGUMENTS", "Hook event or workspace metadata is invalid");
  }
  for (const field of ["cwd", "modelName", "lastUserInput", "terminationReason", "error"]) {
    const item = data[field];
    if (item !== undefined && (typeof item !== "string" || item.length > 128 * 1024)) {
      throw new PluginError("INVALID_ARGUMENTS", "Invalid hook text field");
    }
  }
  for (const field of ["fullyIdle", "continuationActive"]) {
    if (data[field] !== undefined && typeof data[field] !== "boolean") {
      throw new PluginError("INVALID_ARGUMENTS", "Invalid hook continuation metadata");
    }
  }
  if (data.executionNum !== undefined && (!Number.isSafeInteger(data.executionNum) || Number(data.executionNum) < 0)) {
    throw new PluginError("INVALID_ARGUMENTS", "Invalid hook execution number");
  }
  return data as unknown as HookInput;
}

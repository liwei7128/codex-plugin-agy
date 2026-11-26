import { asRecord, type RpcFrame } from "./protocol.js";

export interface ApprovalEvent { method: string; params: Record<string, unknown> }

export function denyServerRequest(frame: RpcFrame): { response: RpcFrame; event?: ApprovalEvent } {
  const method = frame.method ?? "";
  const event = { method, params: asRecord(frame.params) };
  const id = frame.id;
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { response: { id, result: { decision: "cancel" } }, event };
    case "item/permissions/requestApproval":
      return { response: { id, result: { permissions: {}, scope: "turn" } }, event };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { response: { id, result: { decision: "abort" } }, event };
    case "item/tool/requestUserInput":
    case "mcpServer/elicitation/request":
      return { response: { id, error: { code: -32601, message: "Interactive input is unavailable. Resume in Codex CLI." } }, event };
    default:
      return { response: { id, error: { code: -32601, message: "Unsupported App Server request" } } };
  }
}

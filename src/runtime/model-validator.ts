import { AppServerRpcError, type AppServerClient, type Model } from "../app-server/index.js";
import { PluginError } from "../security/index.js";

export async function validateModel(
  client: Pick<AppServerClient, "request">,
  model: string,
  effort: string,
  options: { requiresOpenaiAuth: boolean; modelProvider?: string | null },
): Promise<{ status: "verified" | "unverified_custom_provider"; model: Model | null }> {
  const visible = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    let response;
    try {
      response = await client.request("model/list", {
        cursor, includeHidden: true, modelProvider: options.modelProvider ?? undefined, limit: 100,
      });
    } catch (error) {
      if (error instanceof AppServerRpcError && error.rpcCode === -32601 && !options.requiresOpenaiAuth && !cursor) {
        return { status: "unverified_custom_provider", model: null };
      }
      throw error;
    }
    if (!response || !Array.isArray(response.data) ||
        (response.nextCursor !== null && typeof response.nextCursor !== "string")) {
      throw new PluginError("PROTOCOL_MALFORMED_RESPONSE", "Invalid model/list response");
    }
    for (const candidate of response.data) {
      if (!candidate || typeof candidate.id !== "string" || typeof candidate.model !== "string" ||
          !Array.isArray(candidate.supportedReasoningEfforts)) {
        throw new PluginError("PROTOCOL_MALFORMED_RESPONSE", "Invalid model catalog entry");
      }
      if (!candidate.hidden) visible.add(candidate.id);
      if (candidate.id !== model && candidate.model !== model) continue;
      const efforts = candidate.supportedReasoningEfforts.map(entry => entry.reasoningEffort);
      if (efforts.length && !efforts.includes(effort)) {
        throw new PluginError("EFFORT_UNSUPPORTED", "Requested reasoning effort is unavailable for " + model, {
          details: { model, requestedEffort: effort, supportedEfforts: efforts.slice(0, 50) },
          remediation: ["Choose a supported reasoning effort."],
        });
      }
      return { status: "verified", model: candidate };
    }
    if (page === 0 && response.data.length === 0 && response.nextCursor === null && !options.requiresOpenaiAuth) {
      return { status: "unverified_custom_provider", model: null };
    }
    if (response.nextCursor === null) {
      throw new PluginError("MODEL_UNAVAILABLE", "Requested model is unavailable: " + model, {
        details: { model, availableModels: [...visible].slice(0, 50) },
        remediation: ["Check access on the active Codex account or choose an available model explicitly."],
      });
    }
    cursor = response.nextCursor;
    if (cursors.has(cursor)) break;
    cursors.add(cursor);
  }
  throw new PluginError("PROTOCOL_MALFORMED_RESPONSE", "Invalid or unbounded pagination in the model catalog");
}

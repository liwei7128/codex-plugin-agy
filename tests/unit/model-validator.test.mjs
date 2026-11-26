import assert from "node:assert/strict";
import test from "node:test";
import { AppServerRpcError } from "../../dist/lib/app-server/index.js";
import { validateModel } from "../../dist/lib/runtime/index.js";

const options = { requiresOpenaiAuth: true };
const mock = { id: "gpt-6.2-sol", model: "gpt-6.2-sol", hidden: false,
  supportedReasoningEfforts: ["high", "max", "ultra"].map(reasoningEffort => ({ reasoningEffort })) };

test("dynamic catalog pagination and open-ended effort support", async () => {
  const client = { request: async (_method, params) => params.cursor
    ? { data: [mock], nextCursor: null }
    : { data: [], nextCursor: "next" } };
  for (const effort of ["high", "max", "ultra"]) {
    assert.equal((await validateModel(client, mock.id, effort, options)).status, "verified");
  }
  await assert.rejects(validateModel(client, mock.id, "minimal", options), { code: "EFFORT_UNSUPPORTED" });
  await assert.rejects(validateModel(client, "missing", "high", options), { code: "MODEL_UNAVAILABLE" });
});

test("only an authenticated-free provider can proceed without a catalog", async () => {
  for (const client of [
    { request: async () => ({ data: [], nextCursor: null }) },
    { request: async () => { throw new AppServerRpcError({ code: -32601, message: "Not supported" }); } },
  ]) {
    assert.equal((await validateModel(client, "custom", "high", { requiresOpenaiAuth: false })).status,
      "unverified_custom_provider");
    await assert.rejects(validateModel(client, "custom", "high", options));
  }
});

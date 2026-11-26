import assert from "node:assert/strict";
import test from "node:test";
import { SecretRedactor } from "../../dist/lib/security/redactor.js";

test("redact the nine secret classes in nested arrays and objects", () => {
  const cases = {
    OPENAI_KEY: "sk-proj-" + "A".repeat(25),
    ANTHROPIC_KEY: "sk-ant-" + "B".repeat(25),
    GOOGLE_API_KEY: "AIza" + "C".repeat(35),
    GITHUB_TOKEN: "ghp_" + "D".repeat(32),
    AWS_KEY: "AKIA" + "E".repeat(16),
    AUTH_HEADER: "Authorization: Bearer fixture-auth-value",
    JWT: ["eyJ" + "F".repeat(15), "eyJ" + "G".repeat(15), "H".repeat(15)].join("."),
    PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----",
    ENV_SECRET: "fixture-environment-value",
  };
  const redactor = new SecretRedactor({ TEST_TOKEN: cases.ENV_SECRET });
  const result = redactor.deep({ nested: Object.values(cases) }).nested;
  Object.keys(cases).forEach((type, index) => assert.match(result[index], new RegExp("REDACTED:" + type)));
  assert.equal(redactor.deep({ authorization: "Bearer fixture" }).authorization, "[REDACTED:AUTH_HEADER]");
  assert.deepEqual(redactor.deep(JSON.parse('{"__proto__":{"polluted":true}}')), JSON.parse('{"__proto__":{"polluted":true}}'));
});

test("redacts nested values under generic credential keys", () => {
  const fields = { secret: "fixture", Token: "fixture", privateKey: { encoded: "fixture" }, "auth_token": "fixture" };
  assert.deepEqual(new SecretRedactor({}).deep(fields), Object.fromEntries(
    Object.keys(fields).map(key => [key, "[REDACTED:ENV_SECRET]"]),
  ));
});

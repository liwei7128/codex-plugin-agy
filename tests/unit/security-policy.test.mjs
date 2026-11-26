import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeOption, resolvePolicy, sameApprovalPolicy, stricterApproval } from "../../dist/lib/security/policy.js";

test("write access is explicit and respects the Codex sandbox ceiling", () => {
  assert.equal(resolvePolicy({ sandbox_mode: "workspace-write" }).sandbox, "read-only");
  assert.throws(() => resolvePolicy({ sandbox_mode: "read-only" }, { sandbox: "workspace-write" }), { code: "POLICY_VIOLATION" });
  assert.equal(resolvePolicy({}, { sandbox: "workspace-write" }).sandbox, "workspace-write");
  assert.equal(resolvePolicy({}, { sandbox: "workspace-write" }, true).sandbox, "read-only");
});

test("approval and network access remain monotonic", () => {
  for (const baseline of ["on-request", "untrusted"]) {
    assert.equal(resolvePolicy({ approval_policy: baseline }, { approvalPolicy: "never" }).approvalPolicy, baseline);
  }
  const granular = { granular: { sandbox_approval: true, rules: true, skill_approval: false, request_permissions: true, mcp_elicitations: false } };
  assert.deepEqual(resolvePolicy({ approval_policy: granular }, { approvalPolicy: "never" }).approvalPolicy, granular);
  for (const baseline of [false, true]) {
    for (const requested of [false, true, undefined]) {
      assert.equal(resolvePolicy({ sandbox_workspace_write: { network_access: baseline } },
        { sandbox: "workspace-write", networkAccess: requested }).networkAccess, baseline && requested !== false);
    }
  }
});

test("unsafe modes and flags are rejected", () => {
  for (const value of ["danger-full-access", "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust", "--approve-for-me=true"]) {
    assert.throws(() => assertSafeOption(value), { code: "POLICY_VIOLATION" });
  }
  assert.throws(() => resolvePolicy({}, { sandbox: "danger-full-access" }), { code: "POLICY_VIOLATION" });
});

test("granular restrictions compare by key and cannot be weakened by mixed modes", () => {
  const original = { granular: { sandbox_approval: false, rules: true, skill_approval: false, request_permissions: true, mcp_elicitations: false } };
  const reordered = { granular: Object.fromEntries(Object.entries(original.granular).reverse()) };
  const tighter = { granular: { ...reordered.granular, rules: false } };
  assert.equal(sameApprovalPolicy(original, reordered), true);
  assert.equal(sameApprovalPolicy(original, tighter), false);
  assert.deepEqual(stricterApproval(original, tighter), tighter);
  assert.deepEqual(stricterApproval(tighter, original), tighter);
  assert.throws(() => stricterApproval(original, "untrusted"), { code: "POLICY_VIOLATION" });
  assert.throws(() => stricterApproval("on-request", original), { code: "POLICY_VIOLATION" });
});

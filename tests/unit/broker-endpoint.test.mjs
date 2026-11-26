import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { brokerDirectory, endpointPath, makeBrokerEndpoint } from "../../dist/lib/app-server/broker-endpoint.js";

test("broker endpoints are randomized and confined to an owner directory", t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ca-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = brokerDirectory(root, root);
  assert.equal(path.dirname(directory), path.join(root, "run"));
  if (process.platform !== "win32") assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  const unix = makeBrokerEndpoint(directory, "linux");
  assert.equal(path.dirname(endpointPath(unix)), directory);
  const pipe = makeBrokerEndpoint(directory, "win32");
  assert.match(endpointPath(pipe), /codex-agy-[a-f0-9]{16}$/);
  assert.notEqual(pipe, makeBrokerEndpoint(directory, "win32"));
  assert.throws(() => endpointPath("tcp:localhost:31337"), { code: "APP_SERVER_START_FAILED" });
});

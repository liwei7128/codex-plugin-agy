import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const json = filename => JSON.parse(fs.readFileSync(filename, "utf8"));
test("hooks are native, relative and disabled by default", () => {
  const group = json("hooks.json")["codex-review-gate"];
  assert.equal(group.enabled, false);
  for (const event of ["SessionStart", "Stop"]) {
    assert.equal(group[event][0].command, "node ./scripts/hooks.mjs " + event);
  }
  assert.ok(group.Stop[0].timeout > 300);
});
test("Schema v1 manifest and native MCP configuration", () => {
  const manifest = json("plugin.json");
  const allowed = ["$schema","name","displayName","description","version","logo","author","repository","license","suggestedPrompts","keywords"];
  assert.ok(Object.keys(manifest).every(key => allowed.includes(key)));
  assert.equal(manifest.$schema, "https://antigravity.google/schemas/v1/plugin.json");
  assert.match(manifest.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.match(manifest.repository, /^https:\/\//);
  assert.ok(manifest.suggestedPrompts.length <= 3 && manifest.suggestedPrompts.every(prompt => prompt.trim()));
  assert.match(fs.readFileSync(manifest.logo,"utf8"), /viewBox="0 0 128 128"/);
  const config = json("mcp_config.json").mcpServers.codex;
  assert.deepEqual(config.args, ["${PLUGIN_ROOT}/scripts/mcp-server.mjs"]);
  assert.deepEqual(config.env, { CODEX_PLUGIN_AGY_DATA_DIR: "${PLUGIN_DATA}" });
  assert.equal(config.timeoutSeconds, 600);
  assert.deepEqual(Object.keys(config.tools), ["codex_delegate", "codex_status", "codex_result"]);
});
test("ten matching skill frontmatters and opt-in rules", () => {
  const skills = fs.readdirSync("skills", { withFileTypes: true }).filter(entry => entry.isDirectory());
  assert.equal(skills.length, 10);
  for (const dir of skills) {
    const content = fs.readFileSync(path.join("skills",dir.name,"SKILL.md"),"utf8").replaceAll("\r\n", "\n");
    assert.ok(content.startsWith("---\nname: " + dir.name + "\ndescription: "));
    assert.doesNotMatch(content, /CLAUDE_|\.claude-plugin/);
  }
  const rules = fs.readFileSync("rules/AGENTS.md", "utf8");
  assert.ok(Buffer.byteLength(rules) < 4096);
  assert.ok(!rules.startsWith("---"));
  assert.match(fs.readFileSync("rules/codex-delegated-mode.md", "utf8"), /^---\r?\ntrigger: manual/m);
});

test("user-facing plugin content carries Antigravity terminology", () => {
  function check(file) {
    if (fs.statSync(file).isDirectory()) {
      for (const child of fs.readdirSync(file)) check(path.join(file, child));
      return;
    }
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /CLAUDE_|\.claude-plugin|claude_code_codex_plugin|\/codex:|\bClaude\b/i, file);
  }
  for (const file of ["prompts", "skills", "rules", "plugin.json", "mcp_config.json", "hooks.json"]) check(file);
});

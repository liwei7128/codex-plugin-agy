import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { deflateRawSync } from "node:zlib";
import { writeFileAtomic } from "../src/upstream/fs.mjs";

const root = fs.realpathSync.native(fileURLToPath(new URL("../", import.meta.url)));
const dist = path.join(root, "dist");
fs.mkdirSync(dist, { recursive: true });
if (fs.realpathSync.native(dist) !== dist) throw new Error("dist must be a local build directory");

const compiled = spawnSync(process.execPath, [path.join(root, "scripts", "build.mjs")], {
  cwd: root, shell: false, stdio: "inherit", windowsHide: true,
});
if (compiled.error) throw compiled.error;
if (compiled.status !== 0) process.exit(compiled.status ?? 1);

const stage = fs.mkdtempSync(path.join(dist, ".plugin-"));
const target = path.join(dist, "plugin");
const releases = path.join(dist, "releases");
const backup = stage + "-previous";
const runtimeFiles = ["plugin.json", "mcp_config.json", "hooks.json", "README.md", "LICENSE", "NOTICE", "UPSTREAM.md"];
const runtimeDirs = ["assets", "prompts", "schemas", "skills", "rules"];
const runtimeScripts = ["mcp-server", "task-worker", "app-server-broker", "hooks"];

function filesIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesIn(filename);
    if (entry.isFile()) return [filename];
    throw new Error("Build artifacts must be regular files");
  });
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(directory) {
  const locals = [];
  const central = [];
  let offset = 0;
  let centralBytes = 0;
  for (const file of filesIn(directory)) {
    const name = Buffer.from(path.relative(directory, file).split(path.sep).join("/"));
    const body = fs.readFileSync(file);
    const compressed = deflateRawSync(body);
    const crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    local.copy(entry, 6, 4, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    central.push(entry, name);
    offset += local.length + name.length + compressed.length;
    centralBytes += entry.length + name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(centralBytes, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

let savedPrevious = false;
let installed = false;
try {
  for (const filename of runtimeFiles) fs.copyFileSync(path.join(root, filename), path.join(stage, filename));
  for (const name of runtimeDirs) fs.cpSync(path.join(root, name), path.join(stage, name), { recursive: true });
  fs.mkdirSync(path.join(stage, "scripts"));
  for (const name of runtimeScripts) {
    fs.copyFileSync(path.join(dist, "runtime", name + ".mjs"), path.join(stage, "scripts", name + ".mjs"));
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(stage, "plugin.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("Expected a numeric release version");
  const archive = zip(stage);
  fs.mkdirSync(releases, { recursive: true });
  if (fs.realpathSync.native(releases) !== releases) throw new Error("Invalid release output directory");
  if (fs.existsSync(target)) {
    if (fs.realpathSync.native(target) !== target) throw new Error("Invalid existing plugin output directory");
    fs.renameSync(target, backup);
    savedPrevious = true;
  }
  fs.renameSync(stage, target);
  installed = true;
  writeFileAtomic(path.join(releases, "codex-plugin-agy-" + manifest.version + ".zip"), archive);
  console.log("Built dist/plugin and dist/releases/codex-plugin-agy-" + manifest.version + ".zip");
} finally {
  if (!installed && savedPrevious) fs.renameSync(backup, target);
  if (fs.existsSync(stage) && fs.realpathSync.native(stage) === stage) fs.rmSync(stage, { recursive: true, force: true });
  if (installed && savedPrevious && fs.realpathSync.native(backup) === backup) fs.rmSync(backup, { recursive: true, force: true });
}

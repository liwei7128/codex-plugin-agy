import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

export function ensureAbsolutePath(cwd, maybePath) {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(cwd, maybePath);
}

export function createTempDir(prefix = "codex-plugin-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJsonFile(filePath, value) {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

// [codex-plugin-agy] Stage, sync, and replace in the target directory.
/** @param {string} filePath @param {string | Buffer} content @param {{mode?: number}} [options] */
export function writeFileAtomic(filePath, content, { mode = 0o600 } = {}) {
  const temp = filePath + ".tmp." + process.pid + "." + randomUUID();
  let created = false;
  try {
    const fd = fs.openSync(temp, "wx", mode);
    created = true;
    try {
      fs.writeFileSync(fd, content, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temp, filePath);
        created = false;
        return;
      } catch (error) {
        if (process.platform !== "win32" || attempt >= 5 ||
            !["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
        waitForFile(10 * 2 ** attempt);
      }
    }
  } finally {
    if (created) fs.rmSync(temp, { force: true });
  }
}

const fileWait = new Int32Array(new SharedArrayBuffer(4));

/** @param {number} ms */
function waitForFile(ms) {
  Atomics.wait(fileWait, 0, 0, ms);
}

/** @param {string} file @param {import('node:fs').Stats} stat */
function abandonedLock(file, stat) {
  if (!stat.isFile()) throw new Error("State lock must be a regular file");
  if (Date.now() - stat.mtimeMs <= 30_000) return false;
  const text = fs.readFileSync(file, "utf8").trim();
  const owner = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(owner) || owner <= 0 || owner > 0x7fffffff) return true;
  try {
    process.kill(owner, 0);
    return false;
  } catch (probe) {
    return probe.code === "ESRCH";
  }
}

/** @param {string} file @param {import('node:fs').Stats} expected */
function unlinkSameLock(file, expected) {
  try {
    const current = fs.lstatSync(file);
    if (current.isFile() && current.ino === expected.ino && current.dev === expected.dev &&
        current.birthtimeMs === expected.birthtimeMs && current.mtimeMs === expected.mtimeMs && current.size === expected.size) {
      fs.unlinkSync(file);
    }
  } catch (race) {
    if (race.code !== "ENOENT") throw race;
  }
}

/** @param {string} lockPath @param {import('node:fs').Stats} stat */
function recoverLock(lockPath, stat) {
  const guard = lockPath + ".recovery";
  let recovery;
  try {
    recovery = fs.openSync(guard, "wx", 0o600);
  } catch (race) {
    if (race.code !== "EEXIST") throw race;
    const previous = fs.lstatSync(guard);
    if (abandonedLock(guard, previous)) recoverLock(guard, previous);
    return;
  }
  try {
    fs.writeFileSync(recovery, String(process.pid));
    unlinkSameLock(lockPath, stat);
  } finally {
    const owned = fs.fstatSync(recovery);
    fs.closeSync(recovery);
    unlinkSameLock(guard, owned);
  }
}

// [codex-plugin-agy] Serialize synchronous read/modify/write transactions.
/** @template T @param {string} lockPath @param {() => T} action @returns {T} */
export function withFileLock(lockPath, action) {
  const deadline = performance.now() + 5000;
  let fd;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const stat = fs.lstatSync(lockPath);
        if (abandonedLock(lockPath, stat)) recoverLock(lockPath, stat);
      } catch (race) {
        if (race.code !== "ENOENT") throw race;
      }
      if (performance.now() >= deadline) throw new Error("Timed out acquiring state lock");
      waitForFile(20);
    }
  }
  try {
    fs.writeFileSync(fd, String(process.pid), "utf8");
    return action();
  } finally {
    const owned = fs.fstatSync(fd);
    fs.closeSync(fd);
    unlinkSameLock(lockPath, owned);
  }
}

export function safeReadFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}

export function readStdinIfPiped() {
  if (process.stdin.isTTY) {
    return "";
  }
  return fs.readFileSync(0, "utf8");
}

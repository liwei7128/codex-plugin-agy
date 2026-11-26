import fs from "node:fs";
import { SecretRedactor, utf8Page } from "../security/index.js";

const redact = new SecretRedactor();
const maxLogBytes = 1024 * 1024;

export function appendLog(file: string, message: string): void {
  const line = utf8Page(redact.text(message).replaceAll(/[\r\n]/g, " "), 0, 4096).text + "\n";
  const fd = fs.openSync(file, "a", 0o600);
  try {
    if (fs.fstatSync(fd).size + Buffer.byteLength(line) <= maxLogBytes) fs.writeSync(fd, line, undefined, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export function readLogChunk(file: string, cursor: number, maxBytes: number) {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "", nextCursor: null, totalBytes: 0, returnedBytes: 0 };
    throw error;
  }
  try {
    const totalBytes = fs.fstatSync(fd).size;
    const start = Math.max(0, Math.min(cursor, totalBytes));
    const size = Math.max(0, Math.min(totalBytes - start, maxBytes));
    const buffer = Buffer.alloc(size + 1);
    const read = fs.readSync(fd, buffer, 0, Math.min(size + 1, totalBytes - start), start);
    let first = 0;
    let end = Math.min(read, size);
    while (first < end && (buffer[first] & 0xc0) === 0x80) first++;
    while (end > first && end < read && (buffer[end] & 0xc0) === 0x80) end--;
    return {
      text: buffer.subarray(first, end).toString("utf8"),
      returnedBytes: end - first, totalBytes,
      nextCursor: start + end < totalBytes ? start + Math.max(first, end) : null,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function latestLogLines(file: string, maxLines: number): string[] {
  if (maxLines <= 0) return [];
  const total = readLogChunk(file, 0, 0).totalBytes;
  return readLogChunk(file, Math.max(0, total - 8192), 8192).text.trimEnd().split("\n").filter(Boolean).slice(-maxLines);
}

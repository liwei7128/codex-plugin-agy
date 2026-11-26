export function utf8Page(text: string, offset: number, maxBytes: number) {
  const bytes = Buffer.from(text);
  let start = Math.min(Math.max(offset, 0), bytes.length);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  let end = Math.min(start + Math.max(maxBytes, 0), bytes.length);
  while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return {
    text: bytes.subarray(start, end).toString("utf8"),
    totalBytes: bytes.length,
    returnedBytes: end - start,
    nextCursor: end < bytes.length ? end : null,
  };
}

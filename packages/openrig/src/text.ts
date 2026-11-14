/** Cuts text to at most maxBytes of UTF-8 without splitting a character. */
export function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

/** Keeps the end of the text, for logs. */
export function truncateTail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  let start = buf.length - maxBytes;
  while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start++;
  return { text: buf.subarray(start).toString("utf8"), truncated: true };
}

/**
 * Models often send "" for optional fields they mean to leave out (namespace: "" next to allNamespaces).
 * Drop blank strings, but only for top-level keys not in `required`: a required "" such as
 * fs_edit newText is meaningful.
 */
export function dropBlank(params: unknown, required: readonly string[]): unknown {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return params;
  return Object.fromEntries(Object.entries(params).filter(([k, v]) => required.includes(k) || !(typeof v === "string" && v.trim() === "")));
}

/**
 * Pi's base prompt carries a <docs> block that points at its own README and docs for harness work. A locked seat
 * never works on Pi, so the block is dead weight in every request. Removes the first such block; no block, no change.
 */
export function dropPiDocs(prompt: string): string {
  return prompt.replace(/\n?<docs>\nPi documentation[\s\S]*?\n<\/docs>\n?/, "");
}

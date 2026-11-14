import { closeSync, fstatSync, openSync, readdirSync, readSync, writeSync, type Dirent } from "node:fs";
import { join, relative } from "node:path";
import { confineRead, confineWrite, displayPath, isDeniedName, READ_FLAGS, readRoots, WRITE_FLAGS, type ConfinedPath } from "./paths.ts";
import type { Policy } from "./policy.ts";
import { childEnv, type CommandRunner } from "./runner.ts";
import { truncateText } from "./text.ts";

export class FsError extends Error {
  override name = "FsError";
}

function readWhole(path: ConfinedPath, maxBytes: number): Buffer {
  const fd = openSync(path, READ_FLAGS);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new FsError("not a regular file");
    if (st.size > maxBytes) throw new FsError(`file is ${st.size} bytes; limit is ${maxBytes}`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

export function readBytes(policy: Policy, input: string, maxBytes: number): { path: ConfinedPath; bytes: Buffer } {
  const path = confineRead(policy, input);
  return { path, bytes: readWhole(path, maxBytes) };
}

export function fsRead(policy: Policy, params: { path: string; offset?: number; limit?: number }): string {
  const path = confineRead(policy, params.path);
  const text = readWhole(path, 20 * 1024 * 1024).toString("utf8");
  const lines = text.split("\n");
  const start = Math.max(1, params.offset ?? 1);
  const limit = Math.min(params.limit ?? policy.limits.readLines, policy.limits.readLines);
  let slice = lines.slice(start - 1, start - 1 + limit);
  const body = truncateText(slice.join("\n"), policy.limits.readBytes);
  // A byte cut ends on the last whole line, so offset picks up exactly where the text stdev. One line longer
  // than readBytes is shown cut and skipped.
  let cutLine = false;
  if (body.truncated) {
    const whole = body.text.split("\n").length - 1;
    if (whole > 0) slice = slice.slice(0, whole);
    else {
      slice = [body.text];
      cutLine = true;
    }
  }
  const end = start - 1 + slice.length;
  const more = end < lines.length ? `\n[lines ${start}-${end} of ${lines.length}; continue with offset=${end + 1}]` : "";
  return `${displayPath(policy, path)}\n${slice.join("\n")}${cutLine ? `\n[line ${start} cut at ${policy.limits.readBytes} bytes; use fs_search for it]` : ""}${more}`;
}

export function fsList(policy: Policy, params: { path?: string; depth?: number }): string {
  const depth = Math.min(Math.max(params.depth ?? 1, 1), 4);
  if (!params.path) {
    return readRoots(policy)
      .map((r) => `${r.name}: ${r.path}`)
      .join("\n");
  }
  const root = confineRead(policy, params.path);
  const out: string[] = [];
  const walk = (dir: string, level: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      throw new FsError(`cannot list: ${error instanceof Error ? error.message : String(error)}`);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= policy.limits.listEntries) return;
      if (policy.deny.pathSegments.includes(entry.name) || isDeniedName(entry.name, policy.deny)) continue;
      const full = join(dir, entry.name);
      const rel = relative(root, full);
      const suffix = entry.isDirectory() ? "/" : entry.isSymbolicLink() ? "@" : "";
      out.push(rel + suffix);
      if (entry.isDirectory() && level < depth) walk(full, level + 1);
    }
  };
  walk(root, 1);
  const capped = out.length >= policy.limits.listEntries ? `\n[capped at ${policy.limits.listEntries} entries]` : "";
  return `${displayPath(policy, root)}\n${out.join("\n")}${capped}`;
}

function writeAll(path: ConfinedPath, content: string, maxBytes: number): number {
  const buf = Buffer.from(content, "utf8");
  if (buf.length > maxBytes) throw new FsError(`content is ${buf.length} bytes; limit is ${maxBytes}`);
  const fd = openSync(path, WRITE_FLAGS, 0o644);
  try {
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
  } finally {
    closeSync(fd);
  }
  return buf.length;
}

export function fsWrite(policy: Policy, params: { path: string; content: string }): { path: ConfinedPath; message: string } {
  const path = confineWrite(policy, params.path);
  const n = writeAll(path, params.content, policy.limits.writeBytes);
  return { path, message: `wrote ${n} bytes to ${displayPath(policy, path)}` };
}

export interface EditBlock {
  readonly oldText: string;
  readonly newText: string;
}

export function applyEdits(original: string, edits: readonly EditBlock[]): string {
  if (edits.length === 0) throw new FsError("no edits given");
  const spans: { start: number; end: number; newText: string }[] = [];
  for (const [i, edit] of edits.entries()) {
    if (edit.oldText.length === 0) throw new FsError(`edit ${i + 1}: oldText is empty`);
    const first = original.indexOf(edit.oldText);
    if (first < 0) throw new FsError(`edit ${i + 1}: oldText not found`);
    if (original.indexOf(edit.oldText, first + 1) >= 0) throw new FsError(`edit ${i + 1}: oldText matches more than once`);
    spans.push({ start: first, end: first + edit.oldText.length, newText: edit.newText });
  }
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1];
    const cur = spans[i];
    if (prev && cur && cur.start < prev.end) throw new FsError("edits overlap");
  }
  let result = "";
  let cursor = 0;
  for (const span of spans) {
    result += original.slice(cursor, span.start) + span.newText;
    cursor = span.end;
  }
  return result + original.slice(cursor);
}

export function fsEdit(policy: Policy, params: { path: string; edits: readonly EditBlock[] }): { path: ConfinedPath; message: string } {
  const path = confineWrite(policy, params.path);
  const original = readWhole(path, policy.limits.writeBytes).toString("utf8");
  const next = applyEdits(original, params.edits);
  writeAll(path, next, policy.limits.writeBytes);
  return { path, message: `applied ${params.edits.length} edit(s) to ${displayPath(policy, path)}` };
}

export async function fsSearch(
  policy: Policy,
  runner: CommandRunner,
  params: { pattern: string; path?: string; glob?: string; fixedStrings?: boolean; ignoreCase?: boolean },
  signal?: AbortSignal,
): Promise<string> {
  if (params.pattern.length === 0 || params.pattern.length > 500) throw new FsError("pattern must be 1-500 characters");
  const target = confineRead(policy, params.path ?? policy.workspace);
  const args = ["--no-config", "--line-number", "--with-filename", "--color", "never", "--max-columns", "300", "--max-count", "20", "--no-follow"];
  if (params.fixedStrings) args.push("--fixed-strings");
  if (params.ignoreCase) args.push("--ignore-case");
  if (params.glob !== undefined) {
    if (!/^[A-Za-z0-9_.*?/{},[\]-]{1,200}$/.test(params.glob)) throw new FsError("glob has unsupported characters");
    args.push("--glob", params.glob);
  }
  for (const seg of policy.deny.pathSegments) args.push("--glob", `!**/${seg}/**`, "--glob", `!${seg}`);
  for (const name of policy.deny.fileNames) args.push("--iglob", `!**/${name}`);
  for (const prefix of policy.deny.fileNamePrefixes) args.push("--iglob", `!**/${prefix}*`);
  for (const suffix of policy.deny.suffixes) args.push("--iglob", `!**/*${suffix}`);
  args.push("--regexp", params.pattern, "--", target);
  const result = await runner({
    command: policy.binaries.rg,
    args,
    env: childEnv({ home: policy.home, path: policy.childPath }),
    timeoutMs: policy.limits.commandTimeoutSeconds * 1000,
    signal,
  });
  if (result.code === 1) return "no matches";
  if (result.code !== 0) throw new FsError(`search failed: ${result.stderr.trim().slice(0, 500)}`);
  const lines = result.stdout.split("\n").filter(Boolean).slice(0, policy.limits.searchMatches);
  const body = truncateText(lines.join("\n"), policy.limits.outputBytes);
  return body.text + (body.truncated || lines.length >= policy.limits.searchMatches ? "\n[results capped]" : "");
}

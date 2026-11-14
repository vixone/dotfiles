/**
 * remember-gate
 *
 * Dedup gate on `mx remember`, plus graph indexing after a successful one.
 *
 *   DEDUP (before `mx remember` runs)
 *     Ask the memory graph for the calibrated duplicate verdict of the
 *     proposed lesson (the SAME passage comparison memory_check_duplicate
 *     previews). If the verdict is `merge` (>= 0.96) or `likely` (>= 0.93)
 *     AND the matched key differs from the proposed --key, block with a hint
 *     to update the existing lesson instead. `related` (>= 0.90) and below do
 *     NOT block, so close-but-distinct lessons are not locked out. The 0.83
 *     advisory band in ~/Missions.md is a softer manual-merge guideline, not
 *     enforced here. Canonical tiers live in memory-contract.ts (DUP_TIERS).
 *
 *   INDEX (after `mx remember --key K` succeeds)
 *     Index the lesson into the graph with tracked retries. Skipped when the
 *     command points mx at another store (inline or exported MX_DB), so a
 *     bench or test db never leaks into the live graph.
 *
 * Secrets are refused by mx itself (exit 3) on every write: create, update,
 * note, comment and remember. scanForSecrets stays exported for knowledge
 * capture, which scans text before it proposes a write.
 *
 * Bypass:
 *   - MS_REMEMBER_GATE_DISABLED=1                  (skip the gate)
 *   - MS_DEDUP_DISABLED=1                          (indexing only)
 *   - mx remember "..." --key <existing-key>         (dedup never blocks if
 *                                                     the proposed key already
 *                                                     equals the matched key;
 *                                                     mx updates in place)
 *
 * Config (env):
 *   MS_DEDUP_TIMEOUT_MS                            (default 3000)
 *   (The block/allow boundary is the server's calibrated verdict, not a
 *    tunable cosine threshold; there is no MS_DEDUP_THRESHOLD knob.)
 *
 * Cold-start: empty graph -> dedup never blocks (no hits to compare).
 *
 * Known limitations:
 *   - Commands with $(...) substitution, backticks, or heredocs are NOT
 *     parsed (too risky to evaluate). The gate skips them, letting them
 *     through. False negatives are recoverable (run `mx memories <term>`
 *     if dedup matters); false positives (blocking a legit write) are not.
 */

import type { ExtensionAPI, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType, isBashToolResult } from "@earendil-works/pi-coding-agent";

import { createMemoryClient } from "./memory-client.ts";
import { verdictBlocks, type DuplicateResult, type MemoryHit } from "./memory-contract.ts";
import { trackedIndex } from "./knowledge-capture.ts";
import { defaultMxDb } from "../../lib/mx-store.ts";

// --------------------------------------------------------------------------
// Config
// --------------------------------------------------------------------------

type GateConfig = {
	enabled: boolean;
	dedupEnabled: boolean;
	dedupTimeoutMs: number;
};

function loadConfig(): GateConfig {
	const enabled = process.env.MS_REMEMBER_GATE_DISABLED !== "1";
	const dedupEnabled = enabled && process.env.MS_DEDUP_DISABLED !== "1";
	const dedupTimeoutMs = clampInt(process.env.MS_DEDUP_TIMEOUT_MS, 3000, 500, 30000);
	return { enabled, dedupEnabled, dedupTimeoutMs };
}

function clampInt(raw: string | undefined, def: number, lo: number, hi: number): number {
	if (!raw) return def;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < lo || n > hi) return def;
	return n;
}

// --------------------------------------------------------------------------
// Stage 1: Secret scanner
// --------------------------------------------------------------------------

export type SecretMatch = {
	pattern: string;     // human-readable pattern label
	excerpt: string;     // 80-char window around the match
};

const SECRET_PATTERNS: Array<{ label: string; regex: RegExp }> = [
	{
		label: "AWS access key ID (AKIA…)",
		regex: /\bAKIA[0-9A-Z]{16}\b/,
	},
	{
		label: "AWS access key (env-var assignment)",
		regex: /\bAWS_(SECRET_)?(ACCESS_)?KEY(_ID)?\s*[=:]\s*['"]?[A-Za-z0-9/+=]{16,}['"]?/i,
	},
	{
		label: "PEM private key block",
		regex: /-----BEGIN\s+([A-Z]+\s+)?PRIVATE\s+KEY-----/,
	},
	{
		label: "GitHub personal access token (ghp_…)",
		regex: /\bghp_[A-Za-z0-9]{36}\b/,
	},
	{
		label: "GitHub fine-grained PAT (github_pat_…)",
		regex: /\bgithub_pat_[A-Za-z0-9_]{82}\b/,
	},
	{
		label: "Slack token (xox[abp]-…)",
		regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
	},
	{
		label: "Bearer-style token (Authorization: Bearer …)",
		regex: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/,
	},
	{
		label: "Generic password-like assignment",
		regex: /\b(password|passwd|secret|api[_-]?key)\s*[=:]\s*['"][^'"]{8,}['"]/i,
	},
	{
		label: "JWT (eyJ… header)",
		regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
	},
];

// Patterns that may match content but are commonly false-positives in lesson
// bodies (e.g., the literal documentation phrase "AWS_ACCESS_KEY_ID="). If
// a match is followed by a placeholder like <YOUR_KEY>, $VAR, ${VAR}, ..., or
// REDACTED, treat it as not-a-secret.
const PLACEHOLDER_TAIL = /^(\s*[<$]|\s*\.\.\.|\s*REDACTED|\s*\*+|\s*\[REDACTED\])/;

export function scanForSecrets(text: string): SecretMatch | null {
	for (const { label, regex } of SECRET_PATTERNS) {
		const m = text.match(regex);
		if (!m) continue;
		const start = m.index ?? 0;
		const tail = text.slice(start + m[0].length, start + m[0].length + 16);
		if (PLACEHOLDER_TAIL.test(tail)) continue;
		const ctxStart = Math.max(0, start - 20);
		const ctxEnd = Math.min(text.length, start + m[0].length + 20);
		const excerpt = text.slice(ctxStart, ctxEnd).replace(/\s+/g, " ");
		return { pattern: label, excerpt };
	}
	return null;
}

// --------------------------------------------------------------------------
// Bash command parsing
// --------------------------------------------------------------------------

export type MxWriteCandidate = {
	kind: "remember" | "create" | "note" | "comment";
	text: string;
	key?: string;
	/** MX_DB set inline or exported earlier in the same command. */
	db?: string;
};

/** Split a compound shell command on `;`, `&&`, `||`, and newlines. Pipes
 * are NOT split: `mx remember | xargs` etc. is nonsensical, and pipe
 * targets are reads.
 */
function splitSegments(command: string): string[] {
	const parts: string[] = [];
	let quote: "'" | '"' | null = null;
	let start = 0;
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		// Backslashes are literal inside single quotes. Outside them, skip
		// escaped characters so '\\'' does not reopen a quote at the escape.
		if (quote === "'") {
			if (c === "'") quote = null;
			continue;
		}
		if (c === "\\") {
			i++;
			continue;
		}
		if (quote === '"') {
			if (c === '"') quote = null;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			continue;
		}
		const paired = (c === "&" || c === "|") && command[i + 1] === c;
		if (c === ";" || c === "\n" || paired) {
			parts.push(command.slice(start, i));
			if (paired) i++;
			start = i + 1;
		}
	}
	parts.push(command.slice(start));
	return parts;
}

/** True if the segment contains shell features that make literal-text
 * extraction unsafe (the rendered text may differ from the source).
 */
function isUnsafeSegment(segment: string): boolean {
	if (segment.includes("$(")) return true;
	if (segment.includes("`")) return true;
	if (/<<-?\s*['"]?\w/.test(segment)) return true; // heredoc
	return false;
}

/** Quote-aware tokenizer. Handles single-quoted (literal), double-quoted
 * (with \" \\ escapes), and unquoted whitespace-separated tokens.
 */
export function tokenize(segment: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	const n = segment.length;
	while (i < n) {
		// Skip whitespace
		while (i < n && /\s/.test(segment[i])) i++;
		if (i >= n) break;

		let token = "";
		while (i < n && !/\s/.test(segment[i])) {
			const c = segment[i];
			if (c === "'") {
				// Single-quoted: literal until next single quote
				const end = segment.indexOf("'", i + 1);
				if (end === -1) {
					token += segment.slice(i + 1);
					i = n;
				} else {
					token += segment.slice(i + 1, end);
					i = end + 1;
				}
			} else if (c === '"') {
				// Double-quoted: scan until next unescaped quote
				let j = i + 1;
				while (j < n) {
					if (segment[j] === "\\" && j + 1 < n) {
						const next = segment[j + 1];
						if (next === '"' || next === "\\" || next === "$" || next === "`") {
							token += next;
							j += 2;
							continue;
						}
						token += segment[j];
						j++;
						continue;
					}
					if (segment[j] === '"') break;
					token += segment[j];
					j++;
				}
				i = j + 1;
			} else if (c === "\\" && i + 1 < n) {
				token += segment[i + 1];
				i += 2;
			} else {
				token += c;
				i++;
			}
		}
		tokens.push(token);
	}
	return tokens;
}

const isMx = (token: string) => token === "mx" || token.endsWith("/mx");

/** Find the mx subcommand we care about within a token list. Returns the
 * subcommand name and the index of the mx token (so the caller can scan
 * args after it).
 */
function findMxSubcommand(tokens: string[]): { kind: MxWriteCandidate["kind"]; idx: number } | null {
	for (let i = 0; i < tokens.length - 1; i++) {
		if (!isMx(tokens[i])) continue;
		const sub = tokens[i + 1];
		if (sub === "remember" || sub === "create" || sub === "note" || sub === "comment") {
			return { kind: sub, idx: i };
		}
	}
	return null;
}

/** Extract the lesson/note/comment text and any --key flag from the args
 * following `mx <subcommand>`. The "text" is the first non-flag positional;
 * for `mx create`, also concatenate -d/--description.
 */
function extractCandidate(kind: MxWriteCandidate["kind"], args: string[]): MxWriteCandidate | null {
	let positional: string | undefined;
	let description: string | undefined;
	let key: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--key" && i + 1 < args.length) {
			key = args[++i];
			continue;
		}
		if (a.startsWith("--key=")) {
			key = a.slice("--key=".length);
			continue;
		}
		if ((a === "-d" || a === "--description") && i + 1 < args.length) {
			description = args[++i];
			continue;
		}
		if (a.startsWith("--description=")) {
			description = a.slice("--description=".length);
			continue;
		}
		// Other known flags that take a value (skip the value)
		if ((a === "--type" || a === "-t" || a === "--parent" || a === "--labels" || a === "-l" ||
			a === "-p" || a === "--priority" || a === "--title" || a === "--design" ||
			a === "--acceptance" || a === "--notes" || a === "--assignee" || a === "-a") && i + 1 < args.length) {
			i++;
			continue;
		}
		// Boolean flags or unknown long flags — skip
		if (a.startsWith("-")) continue;
		// First non-flag positional = text body
		if (positional === undefined) {
			positional = a;
			continue;
		}
		// Subsequent positionals on `mx note`/`mx comment` look like:
		//   mx note <id> "<text>"  → so the SECOND positional is the body
		// Adjust: if we already captured something that looks like an ID
		// (matches `mission-XXX(.N)?` or 8-char hex), treat the second
		// positional as the body.
		if ((kind === "note" || kind === "comment") &&
			/^(mission-[a-z0-9]+(\.\d+)?|[a-f0-9]{6,12})$/i.test(positional)) {
			positional = a;
		}
	}

	const text = [positional, description].filter(Boolean).join("\n").trim();
	if (!text) return null;
	return { kind, text, key };
}

const MX_DB_ASSIGN = /^MX_DB=(.*)$/;

/** Parse a bash command, return the FIRST safe-to-inspect mx write
 * candidate found. Returns null for: not-an-mx-write, unsafe segments,
 * empty-text writes. `db` is set when MX_DB is assigned inline before mx or
 * exported in an earlier segment.
 */
export function parseMxWrite(command: string): MxWriteCandidate | null {
	let exported: string | undefined;
	for (const seg of splitSegments(command)) {
		const trimmed = seg.trim();
		if (!trimmed) continue;
		if (/^export\s/.test(trimmed) && /\bMX_DB=/.test(trimmed) && !isUnsafeSegment(trimmed)) {
			for (const t of tokenize(trimmed)) {
				const m = t.match(MX_DB_ASSIGN);
				if (m) exported = m[1];
			}
			continue;
		}
		// Quick rejects
		if (!/(^|[\s/])mx\s+(remember|create|note|comment)\b/.test(trimmed)) continue;
		if (isUnsafeSegment(trimmed)) continue;

		const tokens = tokenize(trimmed);
		const found = findMxSubcommand(tokens);
		if (!found) continue;
		const candidate = extractCandidate(found.kind, tokens.slice(found.idx + 2));
		if (!candidate) continue;
		const inline = tokens.slice(0, found.idx).map((t) => t.match(MX_DB_ASSIGN)?.[1]).filter((v) => v !== undefined).pop();
		const db = inline ?? exported;
		return db === undefined ? candidate : { ...candidate, db };
	}
	return null;
}

// --------------------------------------------------------------------------
// Stage 2: Dedup against memory graph
// --------------------------------------------------------------------------

// The write gate consumes the SAME structured duplicate verdict as the preview
// (memory_check_duplicate) via the memory-v1 contract. No Markdown regex, no
// separate threshold: the Go server owns the passage comparison, self-key
// exclusion and calibrated tiers, so preview and gate can never disagree.

// --------------------------------------------------------------------------
// Reason formatters
// --------------------------------------------------------------------------

function formatDedupReject(dup: DuplicateResult, top: MemoryHit, candidate: MxWriteCandidate): string {
	const proposed = candidate.key ? ` --key ${candidate.key}` : "";
	const verdictLabel = dup.verdict === "merge" ? "merge candidate" : "likely duplicate";
	return [
		`🛑 remember-gate: blocked \`mx remember${proposed}\`: ${verdictLabel} of an existing lesson.`,
		``,
		`Existing lesson: \`${top.key}\`${top.domain ? ` (${top.domain})` : ""} — score ${top.score.toFixed(3)} (verdict: ${dup.verdict}, tiers merge>=${dup.tiers.merge}/likely>=${dup.tiers.likely}).`,
		`> ${top.excerpt}`,
		``,
		`Recommended actions:`,
		`  • Update the existing lesson:  mx remember "<refined text>" --key ${top.key}`,
		`  • If this is genuinely distinct, refine the wording so it's not a near-duplicate, then retry.`,
		``,
		`To bypass this dedup gate: set MS_DEDUP_DISABLED=1 (mx still refuses secrets).`,
	].join("\n");
}

// --------------------------------------------------------------------------
// Register
// --------------------------------------------------------------------------

export function registerRememberGate(pi: ExtensionAPI): void {
	const cfg = loadConfig();
	if (!cfg.enabled) return;

	const memory = createMemoryClient(pi.exec.bind(pi));

	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const command = event.input.command ?? "";
		if (!command) return;

		const candidate = parseMxWrite(command);
		if (!candidate) return;

		// ---- Dedup (remember-only); mx refuses secrets itself ----
		if (!cfg.dedupEnabled) return;
		if (candidate.kind !== "remember") return;

		try {
			// Same passage comparison + self-key exclusion as the preview: the
			// server excludes candidate.key so an in-place update never blocks.
			const parsed = await memory.checkDuplicateStructured(candidate.text, {
				proposedKey: candidate.key ?? undefined,
				timeout: cfg.dedupTimeoutMs,
				signal: ctx.signal,
			});
			// Graph unavailable / malformed → fail open (never block on a hiccup),
			// but a real read error is surfaced by the preview tool, not here.
			if (!parsed.ok) return;
			const dup = parsed.envelope.duplicate;
			if (!dup || !verdictBlocks(dup.verdict)) return;
			const top = dup.matches[0];
			if (!top) return;
			return { block: true, reason: formatDedupReject(dup, top, candidate) };
		} catch {
			// Timeouts / aborts → fail open (don't block the user on graph hiccups)
			return;
		}
	});

	// ---- Post-remember indexing: after a successful mx remember, index the lesson ----
	pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
		if (!isBashToolResult(event)) return;
		if (event.isError) return;

		const command = typeof event.input === "object" && event.input !== null
			? (event.input as { command?: string }).command ?? ""
			: "";
		if (!command) return;

		const candidate = parseMxWrite(command);
		if (!candidate || candidate.kind !== "remember") return;
		if (!candidate.key) return;
		// A bench or test store must never be indexed into the live graph.
		if (candidate.db !== undefined && candidate.db !== defaultMxDb()) return;

		// Fire and forget — don't block the agent turn for indexing. But do NOT
		// silently swallow failures: a non-zero exit (e.g. the server couldn't
		// open mx.db) means the lesson is in mx but never made it into the graph — exactly the drift that makes
		// /focus prior-art and memory_search miss recent lessons. Surface it so
		// the user knows to run a full memory_sync backfill.
		const key = candidate.key;
		// Tracked retry + reconciliation instead of unobserved fire-and-forget
		// (mission-927.11): a transient index failure is retried, and a persistent
		// one is surfaced as pending-reconcile so the lesson (saved in mx) is not
		// silently missing from the graph.
		trackedIndex(() => memory.addLesson(key))
			.then((outcome) => {
				if (outcome.action === "pending-reconcile" && ctx?.hasUI) {
					ctx.ui.notify(
						`⚠️ Memory index for lesson "${key}" is pending-reconcile after ${outcome.attempts} attempts: ${(outcome.error ?? "").slice(0, 140)}. It's saved in mx but NOT in the graph — run a full memory_sync to backfill.`,
						"warning",
					);
				}
			})
			.catch(() => {
				/* trackedIndex never throws; guard for safety */
			});
	});
}

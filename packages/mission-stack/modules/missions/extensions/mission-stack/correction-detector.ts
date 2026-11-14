/**
 * correction-detector — Phase 1.5
 *
 * Catches user corrections during a session and stashes them as session
 * entries for /land to surface. The user's "no, use bugfix/ not fix/"-style
 * pushbacks are the highest-quality lessons the system can capture; today
 * the user has to remember to type `mx remember`. This detector catches
 * them at message_end (no mid-flow interruptions) and surfaces them as a
 * batch when the user lands the plane.
 *
 * Design contract:
 *   1. NEVER prompt mid-flow. Stash silently; surface at /land.
 *   2. False positives are cheap (user just ignores the candidate at /land).
 *      False negatives are expensive (lesson lost). Bias slightly toward
 *      recall, but suppress trivial conversational uses ("no problem",
 *      "actually that looks great").
 *   3. The actual `mx remember` calls happen via the regular tool path,
 *      so remember-gate (Phase 1.2) protects them automatically — no
 *      special routing needed here.
 *   4. This module owns its session-entry namespace; focus-land calls
 *      `collectCorrectionCandidates()` and `renderCorrectionsSection()`
 *      to compose the augmented /land prompt and `markCorrectionsConsumed()`
 *      to advance the surface cutoff.
 *
 * Hook: message_end (user role only; assistant messages ignored)
 *
 * Configuration (env):
 *   MS_CORRECTION_DISABLED=1            kill switch (no hook registers)
 *   MS_CORRECTION_STRONG_PATTERNS       JSON array of regex strings; overrides defaults
 *   MS_CORRECTION_NEGATIVE_PATTERNS     JSON array of regex strings; overrides defaults
 *   MS_CORRECTION_MIN_LEN               int (default 3)        skip very short prompts ("k", "yes")
 *   MS_CORRECTION_MAX_STORED            int (default 1500)     truncate userText before stashing
 *   MS_CORRECTION_MAX_PER_LAND          int (default 6)        cap number of candidates surfaced at /land
 *
 * Cold-start: works on day 1. Stashes candidates as they happen. /land
 * picks them up. No data dependency.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { parseResumeIntent } from "./mission-resume.ts";

// --------------------------------------------------------------------------
// Session-entry types
// --------------------------------------------------------------------------

export const CORRECTION_ENTRY_TYPE = "correction-candidate";
export const CORRECTION_CONSUMED_TYPE = "correction-consumed";

/** What we stash at message_end. */
export interface CorrectionCandidate {
	/** Wall-clock ms; used as a stable id for the consumed-cutoff. */
	ts: number;
	/** User text without embedded skill instructions, possibly truncated. */
	userText: string;
	/** Last assistant text turn before this one, if any (truncated to ~600 chars).
	 *  Gives /land enough context to know what the user was correcting. */
	priorAssistantTurn?: string;
	/** Which strong pattern matched (regex source). For debugging / telemetry. */
	matchedPattern: string;
}

/** Single record marking a /land that consumed candidates up to `cutoffTs`. */
export interface CorrectionConsumedRecord {
	cutoffTs: number;
	consumedCount: number;
	when: number;
}

// --------------------------------------------------------------------------
// Patterns
// --------------------------------------------------------------------------

/**
 * STRONG patterns — match these and the candidate is stashed (subject to
 * negative suppression). Anchored or word-boundaried to avoid sub-word
 * false positives. All are case-insensitive at compile.
 */
const DEFAULT_STRONG_PATTERN_SOURCES = [
	// "No, X" / "Nope, X" / "Wrong, X" — pushback at start of message
	String.raw`^\s*(?:no|nope|wrong|don'?t|do not|stop)\b`,
	// "actually, no" / "actually use X" / "actually do X" — corrective followup
	String.raw`\bactually,?\s+(?:no|use|do|don'?t|the\s|that's\s+(?:wrong|not))`,
	// "I said X" — clarifying repetition (but exclude "I said nothing")
	String.raw`\bI said\s+(?!nothing\b)`,
	// "use X not Y" / "X, not Y" — explicit substitution
	String.raw`\b(?:use|prefer)\s+\S+\s+(?:not|over|instead of)\s+\S+`,
	String.raw`,\s*not\s+\S+`,
	// "you misread" / "you misunderstood" — meta-correction
	String.raw`\byou (?:misread|misunderstood|got it wrong|missed)\b`,
];

/**
 * NEGATIVE patterns — if any matches, the message is NOT a correction
 * even if a strong pattern matched. These preserve hermes' false-positive
 * guards and add a few common conversational pleasantries.
 */
const DEFAULT_NEGATIVE_PATTERN_SOURCES = [
	String.raw`\bno (?:worries|problem|biggie|rush|need|harm|issues?)\b`,
	String.raw`\bdon'?t worry\b`,
	String.raw`\bactually (?:looks|works|seems|reads|sounds)\s+(?:great|good|fine|right|correct|nice|perfect|excellent)\b`,
	String.raw`\bactually (?:that|this|it)'?s (?:great|good|fine|right|correct|nice|perfect)\b`,
	String.raw`\bno,?\s+(?:wait|actually,?\s+(?:that|this|it)\s+(?:is|looks|seems)\s+(?:great|good|right))\b`,
	// /land template text contains "Do NOT" etc. — not a correction
	String.raw`^LAND THE PLANE`,
	String.raw`^Follow the missions skill`,
];

function compilePatterns(sources: string[]): RegExp[] {
	const out: RegExp[] = [];
	for (const s of sources) {
		try {
			out.push(new RegExp(s, "i"));
		} catch {
			// silently skip invalid user-provided regex; keeps the detector working
		}
	}
	return out;
}

function loadPatterns(envName: string, defaults: string[]): RegExp[] {
	const raw = process.env[envName];
	if (!raw) return compilePatterns(defaults);
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
			return compilePatterns(parsed);
		}
	} catch {
		// fall through to defaults
	}
	return compilePatterns(defaults);
}

function clampInt(raw: string | undefined, def: number, lo: number, hi: number): number {
	if (!raw) return def;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < lo || n > hi) return def;
	return n;
}

type DetectorConfig = {
	enabled: boolean;
	strongPatterns: RegExp[];
	negativePatterns: RegExp[];
	minLen: number;
	maxStored: number;
	maxPerLand: number;
};

function loadConfig(): DetectorConfig {
	return {
		enabled: process.env.MS_CORRECTION_DISABLED !== "1",
		strongPatterns: loadPatterns("MS_CORRECTION_STRONG_PATTERNS", DEFAULT_STRONG_PATTERN_SOURCES),
		negativePatterns: loadPatterns("MS_CORRECTION_NEGATIVE_PATTERNS", DEFAULT_NEGATIVE_PATTERN_SOURCES),
		minLen: clampInt(process.env.MS_CORRECTION_MIN_LEN, 3, 1, 100),
		maxStored: clampInt(process.env.MS_CORRECTION_MAX_STORED, 1500, 200, 20_000),
		maxPerLand: clampInt(process.env.MS_CORRECTION_MAX_PER_LAND, 6, 1, 50),
	};
}

// --------------------------------------------------------------------------
// Detection
// --------------------------------------------------------------------------

/**
 * Returns the matched strong-pattern source if `text` looks like a correction,
 * or null if no strong pattern matched or a negative pattern suppressed it.
 *
 * Exported for unit testing.
 */
export function matchCorrection(
	text: string,
	cfg: Pick<DetectorConfig, "strongPatterns" | "negativePatterns" | "minLen">,
): string | null {
	const t = text.trim();
	if (t.length < cfg.minLen) return null;
	for (const neg of cfg.negativePatterns) {
		if (neg.test(t)) return null;
	}
	for (const re of cfg.strongPatterns) {
		if (re.test(t)) return re.source;
	}
	return null;
}

// --------------------------------------------------------------------------
// Message-content extraction
// --------------------------------------------------------------------------

function correctionText(text: string): string {
	return text.replace(/<skill name="[^"]+" location="[^"]+">\r?\n[\s\S]*?\r?\n<\/skill>/g, "\n").trim();
}

type MessageContentBlock = { type?: string; text?: string };
type AnyMessage = {
	role?: string;
	content?: string | MessageContentBlock[];
};

/** Best-effort plain-text extraction from a UserMessage / AssistantMessage. */
export function extractText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const m = message as AnyMessage;
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) {
		const parts: string[] = [];
		for (const blk of m.content) {
			if (blk && typeof blk === "object" && blk.type === "text" && typeof blk.text === "string") {
				parts.push(blk.text);
			}
		}
		return parts.join("\n");
	}
	return "";
}

/** Walk session entries newest→oldest and return the most recent assistant text turn. */
export function previousAssistantText(ctx: ExtensionContext, maxLen = 600): string | undefined {
	try {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.type === "message") {
				const msg = e.message;
				if (msg && msg.role === "assistant") {
					const txt = extractText(msg).trim();
					if (txt) return txt.length > maxLen ? `${txt.slice(0, maxLen)}…` : txt;
				}
			}
		}
	} catch {
		// non-fatal — context is helpful but not required
	}
	return undefined;
}

// --------------------------------------------------------------------------
// Surfacing helpers (called by focus-land at /land time)
// --------------------------------------------------------------------------

interface CustomEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
	timestamp?: number;
}

/** Latest cutoff timestamp from prior /land consumed records (0 if none). */
function latestConsumedCutoff(entries: ReadonlyArray<unknown>): number {
	let latest = 0;
	for (const raw of entries) {
		const e = raw as CustomEntryLike;
		if (e.type === "custom" && e.customType === CORRECTION_CONSUMED_TYPE) {
			const data = e.data as CorrectionConsumedRecord | undefined;
			const c = Number(data?.cutoffTs ?? 0);
			if (Number.isFinite(c) && c > latest) latest = c;
		}
	}
	return latest;
}

/**
 * Returns correction candidates stashed since the last /land's cutoff,
 * ordered oldest→newest, capped at maxPerLand. Exported so focus-land
 * can render the /land prompt section.
 */
// collectCorrectionCandidates only reads session entries. Typing the full
// ExtensionContext would reject the controller seam's minimal LandPrepareCtx
// (focus-land passes ctx straight to prepare). Narrow to what it uses so both
// the real ExtensionContext and LandPrepareCtx are assignable.
export type CorrectionSource = { sessionManager: { getEntries: () => readonly unknown[] } };

export function collectCorrectionCandidates(
	ctx: CorrectionSource,
	maxPerLand = 6,
): CorrectionCandidate[] {
	let entries: ReadonlyArray<SessionEntry> = [];
	try {
		entries = ctx.sessionManager.getEntries() as ReadonlyArray<SessionEntry>;
	} catch {
		return [];
	}
	const cutoff = latestConsumedCutoff(entries);
	const cfg = loadConfig();
	const out: CorrectionCandidate[] = [];
	for (const [index, e] of entries.entries()) {
		if (e.type !== "custom" || e.customType !== CORRECTION_ENTRY_TYPE) continue;
		const data = e.data as CorrectionCandidate | undefined;
		if (!data) continue;
		if (Number(data.ts) <= cutoff) continue;
		let source = data.userText;
		if (source.includes('<skill name="') && source.endsWith("…")) {
			// Pi persists the user message after message_end appends the candidate.
			const next = entries.slice(index + 1).find(entry => entry.type === "message");
			const fullText = extractText(next?.message).trim();
			if (next?.message?.role === "user" && fullText.startsWith(source.slice(0, -1))) source = fullText;
		}
		const text = correctionText(source);
		if (text === source) {
			out.push(data);
			continue;
		}
		const matched = matchCorrection(text, cfg);
		if (matched) out.push({
			...data,
			userText: text.length > cfg.maxStored ? `${text.slice(0, cfg.maxStored)}…` : text,
			matchedPattern: matched,
		});
	}
	// Process oldest first. A consumed cutoff must not skip earlier candidates.
	if (out.length > maxPerLand) return out.slice(0, maxPerLand);
	return out;
}

/**
 * Renders a markdown section to append to the /land prompt. Returns ""
 * when there are no candidates so the caller can chain `+ section`
 * without conditional logic.
 */
export function renderCorrectionsSection(candidates: ReadonlyArray<CorrectionCandidate>): string {
	if (candidates.length === 0) return "";
	const lines: string[] = [
		"",
		"---",
		"",
		"## Correction candidates from this session",
		"",
		"The detector flagged these as possible corrections. Decide whether each is",
		"a lesson (it counts toward the limit of 2), a mission record, already",
		"captured, or noise. Put any you cannot record in the snapshot's Pending",
		"capture, by substance, without raw messages or secrets.",
		"",
	];
	for (const c of candidates) {
		const ts = new Date(c.ts).toISOString();
		lines.push(`- **[${ts}]** ${truncate(c.userText, 400)}`);
		if (c.priorAssistantTurn) {
			lines.push(`    _prior assistant turn:_ ${truncate(c.priorAssistantTurn, 280)}`);
		}
	}
	lines.push("");
	return lines.join("\n");
}

/**
 * Marks correction candidates as consumed by appending a cutoff record.
 * Called by focus-land only after a completed landing saved a handover.
 * They won't surface again on the next /land.
 */
export function markCorrectionsConsumed(
	pi: Pick<ExtensionAPI, "appendEntry">,
	candidates: ReadonlyArray<CorrectionCandidate>,
): void {
	if (candidates.length === 0) return;
	const cutoffTs = candidates[candidates.length - 1].ts;
	try {
		pi.appendEntry(CORRECTION_CONSUMED_TYPE, {
			cutoffTs,
			consumedCount: candidates.length,
			when: Date.now(),
		} satisfies CorrectionConsumedRecord);
	} catch {
		// non-fatal — at worst the candidates show up again on next /land
	}
}

function truncate(s: string, n: number): string {
	const t = (s ?? "").trim();
	if (t.length <= n) return t;
	return `${t.slice(0, n - 1)}…`;
}

// --------------------------------------------------------------------------
// Register
// --------------------------------------------------------------------------

export function registerCorrectionDetector(pi: ExtensionAPI): void {
	const cfg = loadConfig();
	if (!cfg.enabled) return;

	pi.on("message_end", (event: MessageEndEvent, ctx) => {
		const msg = event.message as AnyMessage | undefined;
		if (!msg || msg.role !== "user") return;

		const text = correctionText(extractText(msg));
		if (!text) return;
		// /continue auto-sends the resume/handover prompt as a user message in the
		// fresh session. Its embedded snapshot body trips strong patterns, so it
		// would self-record as a correction candidate (noise at the next landing).
		// parseResumeIntent is the same anchored matcher auto-focus uses.
		if (parseResumeIntent(text)) return;

		const matched = matchCorrection(text, cfg);
		if (!matched) return;

		const candidate: CorrectionCandidate = {
			ts: Date.now(),
			userText: text.length > cfg.maxStored ? `${text.slice(0, cfg.maxStored)}…` : text,
			priorAssistantTurn: previousAssistantText(ctx),
			matchedPattern: matched,
		};
		try {
			pi.appendEntry(CORRECTION_ENTRY_TYPE, candidate);
		} catch {
			// non-fatal
		}
	});
}

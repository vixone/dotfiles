/**
 * knowledge-capture
 *
 * Routes new information to the right destination and keeps capture reliable
 * (mission-927.11). It does NOT persist anything: it proposes a destination
 * (environment fact / lesson / mission finding-decision-action / transient
 * session state), validates it per type, flags duplicates and refuses secrets.
 * Persistence stays a reviewed action through the existing mx / remember-gate
 * path, so there is no silent promotion of arbitrary retrieved content.
 *
 * It also provides:
 *   - trackedIndex(): tracked-retry indexing so a successful mx write reliably
 *     makes it into the graph (or is reported as pending-reconcile) instead of
 *     unobserved fire-and-forget;
 *
 * NOT a pi extension. Imported by sibling files.
 */

import { scanForSecrets, type SecretMatch } from "./remember-gate.ts";
import { type EnvRecord } from "./environment-source.ts";

export type Destination =
	| "environment"
	| "lesson"
	| "mission-finding"
	| "mission-decision"
	| "mission-action"
	| "transient";

export type CaptureInput = {
	text: string;
	/** Explicit destination hint (e.g. from a slash command or the user). */
	hintType?: Destination;
	/** Environment fact scope + sources (ordinary facts need these, not the
	 * full lesson rubric). */
	scope?: string;
	sources?: string[];
	/** Proposed key (lesson) or id (environment) for duplicate detection. */
	key?: string;
	focusedMissionId?: string | null;
	/** When false, environment destinations are never proposed and mission
	 * capture still works (environment knowledge can be disabled). */
	environmentEnabled?: boolean;
};

export type ValidationResult = { valid: boolean; errors: string[] };

export type CaptureProposal = {
	destination: Destination;
	reason: string;
	validation: ValidationResult;
	/** Set when the input duplicates an existing record/lesson. */
	duplicate?: { of: string; suggestion: string };
	/** Set when a secret was detected; the input must not be persisted. */
	secretBlocked?: SecretMatch;
	/** Always true: capture is a reviewed action, never automatic. */
	requiresReview: boolean;
};

export type ExistingKeys = {
	lessonKeys?: ReadonlySet<string>;
	environmentIds?: ReadonlySet<string>;
};

const LESSON_MIN_LEN = 25;
const COMMAND_LIKE_RE = /[`]|\$\(|\$\{/;

const DECISION_RE = /\b(decided|chose|prefer|going with|use\b.*\binstead)/i;
const FINDING_RE = /\b(found|turns out|root cause|because|the reason|discovered|it was)\b/i;
const ACTION_RE = /\b(implemented|added|ran|created|fixed|wired|deleted|migrated)\b/i;
const LESSON_RE = /\b(always|never|prefer|don'?t|gotcha|remember to|must|watch out)\b/i;
const ENV_RE = /\b(proxy|cluster|credential|endpoint|hosted|hostname|firewall|region|account|profile|no_proxy)\b/i;

function classify(input: CaptureInput): { destination: Destination; reason: string } {
	if (input.hintType) return { destination: input.hintType, reason: "explicit hint" };

	const text = input.text.trim();
	const envOk = input.environmentEnabled !== false;

	// An environment fact is signalled by scope+sources, or strong env cues.
	if (envOk && (input.scope || (input.sources && input.sources.length > 0))) {
		return { destination: "environment", reason: "scope/source provided" };
	}

	// Mission child only makes sense with a focused mission.
	if (input.focusedMissionId) {
		if (DECISION_RE.test(text)) return { destination: "mission-decision", reason: "decision phrasing under a focused mission" };
		if (FINDING_RE.test(text)) return { destination: "mission-finding", reason: "finding phrasing under a focused mission" };
		if (ACTION_RE.test(text)) return { destination: "mission-action", reason: "action phrasing under a focused mission" };
	}

	if (envOk && ENV_RE.test(text) && text.length >= LESSON_MIN_LEN) {
		return { destination: "environment", reason: "environment cue" };
	}

	if (LESSON_RE.test(text) && text.length >= LESSON_MIN_LEN) {
		return { destination: "lesson", reason: "durable-rule phrasing" };
	}

	return { destination: "transient", reason: "no durable signal; treat as session state" };
}

function validate(destination: Destination, input: CaptureInput): ValidationResult {
	const errors: string[] = [];
	const text = input.text.trim();
	switch (destination) {
		case "environment":
			// Ordinary facts need scope + source, NOT the full lesson rubric.
			if (!input.scope) errors.push("environment fact needs a scope");
			if (!input.sources || input.sources.length === 0) errors.push("environment fact needs at least one source");
			if (COMMAND_LIKE_RE.test(text)) errors.push("environment fact must not contain executable command syntax");
			break;
		case "lesson":
			// Non-trivial lesson rubric.
			if (text.length < LESSON_MIN_LEN) errors.push("lesson too short to be reusable");
			if (!LESSON_RE.test(text)) errors.push("lesson should state a durable rule (always/never/prefer/gotcha)");
			break;
		case "mission-finding":
		case "mission-decision":
		case "mission-action":
			if (!input.focusedMissionId) errors.push("mission child needs a focused mission");
			if (text.length < 3) errors.push("empty mission child");
			break;
		case "transient":
			// Session state; nothing to persist, always "valid".
			break;
	}
	return { valid: errors.length === 0, errors };
}

function findDuplicate(input: CaptureInput, destination: Destination, existing?: ExistingKeys): CaptureProposal["duplicate"] {
	if (!existing || !input.key) return undefined;
	if (destination === "lesson" && existing.lessonKeys?.has(input.key)) {
		return { of: input.key, suggestion: `mx remember "<refined>" --key ${input.key}` };
	}
	if (destination === "environment" && existing.environmentIds?.has(input.key)) {
		return { of: input.key, suggestion: `reviewed update of environment record ${input.key}` };
	}
	return undefined;
}

/**
 * Propose where new input should go, with per-type validation, duplicate
 * detection and a secret refusal. Never persists; requiresReview is always
 * true so nothing is silently promoted.
 */
export function proposeDestination(input: CaptureInput, existing?: ExistingKeys): CaptureProposal {
	const secret = scanForSecrets(input.text);
	const { destination, reason } = classify(input);
	if (secret) {
		return {
			destination,
			reason,
			validation: { valid: false, errors: ["secret detected; refuse to persist"] },
			secretBlocked: secret,
			requiresReview: true,
		};
	}
	const validation = validate(destination, input);
	const duplicate = findDuplicate(input, destination, existing);
	return { destination, reason, validation, duplicate, requiresReview: true };
}

// ---------------------------------------------------------------------------
// Environment record updates (reviewed, with history + index invalidation).
// ---------------------------------------------------------------------------

export type EnvUpdatePlan =
	| { action: "needs-review"; reason: string }
	| {
			action: "update";
			id: string;
			scopeId?: string;
			history: Array<{ verifiedAt: string; summary?: string }>;
			verifiedAt: string;
			invalidateIndex: true;
	  };

/**
 * Plan a reviewed update to an environment record by identity/scope. The update
 * is refused unless reviewed === true (no silent promotion). It records the
 * prior value as history and always invalidates the index so the changed fact
 * is re-embedded on the next reconcile.
 */
export function planEnvironmentUpdate(
	existing: EnvRecord,
	proposed: { scopeId?: string; summary?: string; verifiedAt: string },
	opts: { reviewed: boolean },
): EnvUpdatePlan {
	if (!opts.reviewed) return { action: "needs-review", reason: "environment updates require explicit review" };
	const prevScope = proposed.scopeId ? existing.scopes.find((s) => s.id === proposed.scopeId) : undefined;
	const history = [{ verifiedAt: existing.verifiedAt, summary: prevScope?.summary }];
	return {
		action: "update",
		id: existing.id,
		scopeId: proposed.scopeId,
		history,
		verifiedAt: proposed.verifiedAt,
		invalidateIndex: true,
	};
}

// ---------------------------------------------------------------------------
// Reliable indexing (tracked retry / reconciliation).
// ---------------------------------------------------------------------------

export type IndexRunResult = { code: number; stdout: string; stderr: string };
export type IndexOutcome = {
	ok: boolean;
	attempts: number;
	action: "indexed" | "pending-reconcile";
	error?: string;
};

/**
 * Run an index operation with tracked retries. On repeated failure it returns
 * action "pending-reconcile" so the caller can surface it and schedule a full
 * sync, rather than dropping the write into an unobserved fire-and-forget.
 */
export async function trackedIndex(
	run: () => Promise<IndexRunResult>,
	opts: { retries?: number } = {},
): Promise<IndexOutcome> {
	const retries = opts.retries ?? 2;
	let lastErr = "";
	for (let attempt = 1; attempt <= retries + 1; attempt++) {
		try {
			const res = await run();
			if (res.code === 0) return { ok: true, attempts: attempt, action: "indexed" };
			lastErr = (res.stderr || res.stdout || `exit ${res.code}`).trim();
		} catch (e) {
			lastErr = (e as Error).message;
		}
	}
	return { ok: false, attempts: retries + 1, action: "pending-reconcile", error: lastErr };
}

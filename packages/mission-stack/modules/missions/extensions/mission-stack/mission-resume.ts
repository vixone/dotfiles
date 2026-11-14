/**
 * mission-resume
 *
 * Pure helper for auto-focus: detect a "Resume mission-<id> ..." prompt (the
 * shape /land emits) and extract the epic id. Kept out of focus-land.ts so it
 * can be type-checked and unit-tested without the pi runtime types (focus-land
 * is intentionally excluded from tsconfig because it leans on loose SDK types).
 *
 * NOT a pi extension. Imported by focus-land.ts.
 */

// A resume prompt opens with "Resume mission-<id> ...". Anchoring at the start
// and requiring the "resume" verb keeps casual mentions of a mission id from
// hijacking focus. A child id (mission-x.3) is captured then folded to its epic.
const RESUME_INTENT_RE = /^\s*resume\s+(mission-[a-z0-9]+(?:\.\d+)?)\b/i;

/** Extract the epic id from an anchored "Resume mission-<id> ..." prompt, or
 * null when the prompt is not a resume intent. Child ids fold to their epic. */
export function parseResumeIntent(prompt: string): string | null {
	const m = prompt.match(RESUME_INTENT_RE);
	if (!m) return null;
	return m[1].toLowerCase().split(".")[0];
}

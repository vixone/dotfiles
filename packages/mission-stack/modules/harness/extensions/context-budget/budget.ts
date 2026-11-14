export const NUDGE_AT = 150_000;
export const COMPACT_AT = 200_000;

export type BudgetAction = "none" | "nudge" | "compact";

export function budgetAction(
	tokens: number | null,
	nudged: boolean,
	nudgeAt: number = NUDGE_AT,
	compactAt: number = COMPACT_AT,
): BudgetAction {
	if (tokens === null) return "none";
	if (tokens > compactAt) return "compact";
	if (tokens > nudgeAt && !nudged) return "nudge";
	return "none";
}

export const OUTPUT_CAP = 16_384;
const KEEP = 6144;

export function capOutput(text: string, cap: number = OUTPUT_CAP, path?: string): { text: string; spilled: boolean } {
	const total = Buffer.byteLength(text);
	if (total <= cap) return { text, spilled: false };
	const head = text.slice(0, KEEP);
	const tail = text.slice(-KEEP);
	const omitted = total - Buffer.byteLength(head) - Buffer.byteLength(tail);
	return { text: `${head}\n[... ${omitted} bytes omitted, full output: ${path ?? "n/a"}]\n${tail}`, spilled: true };
}

// pi's read tool returns at most 2000 lines, so offset<=1 with limit>=2000 is a full read.
const READ_MAX_LINES = 2000;

export function isRangedRead(input: { offset?: unknown; limit?: unknown }): boolean {
	const offset = Number(input.offset ?? 1);
	const limit = input.limit === undefined ? READ_MAX_LINES : Number(input.limit);
	return offset > 1 || limit < READ_MAX_LINES;
}

export type ReadRecord = { mtimeMs: number; size: number; turn: number };

export function readStub(
	cache: Map<string, ReadRecord>,
	path: string,
	stat: { mtimeMs: number; size: number },
	turn: number,
	ranged: boolean,
): string | undefined {
	if (ranged) return undefined;
	const prev = cache.get(path);
	if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) {
		return `unchanged since turn ${prev.turn}: ${path} was already read in full this session; use the earlier result or read with offset/limit`;
	}
	cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, turn });
	return undefined;
}

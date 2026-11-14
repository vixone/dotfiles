/**
 * Pure text helpers for the pi-bar HUD: braille line graph, block sparkline,
 * usage bar, compact numbers. No theme or TUI imports so they test in plain node.
 */

/** Braille dot bit for [row 0..3][column 0..1] inside one cell. */
const DOT: readonly (readonly [number, number])[] = [
	[0x01, 0x08],
	[0x02, 0x10],
	[0x04, 0x20],
	[0x40, 0x80],
];
const BRAILLE_BASE = 0x2800;

/**
 * FPS-overlay style line graph. Each cell holds 2 samples horizontally and 4
 * dots vertically, so `width` cells show the last `2 * width` samples, newest
 * on the right. Consecutive samples are joined with a vertical run, which gives
 * the jagged frame-time look. Missing history renders as blank cells.
 */
export function brailleGraph(samples: readonly number[], width: number, height: number, max: number): string[] {
	const cols = width * 2;
	const dotsHigh = height * 4;
	const recent = samples.slice(-cols);
	const offset = cols - recent.length;
	const cells: number[][] = Array.from({ length: height }, () => new Array<number>(width).fill(0));
	const top = Math.max(max, 1e-9);
	const level = (v: number) => Math.max(0, Math.min(dotsHigh - 1, Math.round((v / top) * (dotsHigh - 1))));

	let prev: number | undefined;
	for (let i = 0; i < recent.length; i++) {
		const x = offset + i;
		const cur = level(recent[i] ?? 0);
		const from = prev === undefined ? cur : Math.min(prev, cur);
		const to = prev === undefined ? cur : Math.max(prev, cur);
		for (let lv = from; lv <= to; lv++) {
			const y = dotsHigh - 1 - lv;
			const row = cells[Math.floor(y / 4)];
			const bit = DOT[y % 4]?.[x % 2];
			if (row && bit !== undefined) row[Math.floor(x / 2)] = (row[Math.floor(x / 2)] ?? 0) | bit;
		}
		prev = cur;
	}
	return cells.map((row) => row.map((bits) => (bits === 0 ? " " : String.fromCodePoint(BRAILLE_BASE + bits))).join(""));
}

const BLOCKS = "▁▂▃▄▅▆▇█";

/** One-row block sparkline of the last `width` values, scaled to `max`. */
export function sparkline(values: readonly number[], width: number, max: number): string {
	const top = Math.max(max, 1e-9);
	return values
		.slice(-width)
		.map((v) => BLOCKS[Math.max(0, Math.min(BLOCKS.length - 1, Math.round((v / top) * (BLOCKS.length - 1))))])
		.join("");
}

/** Filled/empty split for a usage bar of `width` cells at `percent` (0..100). */
export function barCells(percent: number, width: number): { filled: number; empty: number } {
	const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
	return { filled, empty: width - filled };
}

/** 950 -> "950", 12_345 -> "12k", 1_234_567 -> "1.2M". */
export function compact(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${Math.round(n / 1000)}k`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n)}`;
}

export type GitInfo = { branch: string; ahead: number; behind: number; dirty: number; untracked: number };

/** Parse `git status --porcelain=v1 -b`. Returns undefined outside a repo. */
export function parseGitStatus(out: string): GitInfo | undefined {
	const lines = out.split("\n").filter((l) => l.length > 0);
	const head = lines[0];
	if (!head?.startsWith("## ")) return undefined;
	const info = head.slice(3);
	const branch = info.startsWith("No commits yet on ")
		? info.slice("No commits yet on ".length)
		: (info.split("...")[0] ?? info).split(" ")[0] ?? info;
	const ahead = Number(/ahead (\d+)/.exec(info)?.[1] ?? 0);
	const behind = Number(/behind (\d+)/.exec(info)?.[1] ?? 0);
	let dirty = 0;
	let untracked = 0;
	for (const l of lines.slice(1)) {
		if (l.startsWith("??")) untracked++;
		else dirty++;
	}
	return { branch, ahead, behind, dirty, untracked };
}

/** Value at quantile q (0..1) of the samples; 0 when empty. */
export function quantile(values: readonly number[], q: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

/** Opaque spacing: renders like a space but is not treated as see-through. */
export const NBSP = "\u00a0";

/**
 * Column runs of a plain-text line that are not ASCII spaces. Spaces are the
 * see-through cells; every other character (NBSP included) stays opaque.
 */
export function opaqueRuns(plain: string, cellWidth: (ch: string) => number): { col: number; width: number }[] {
	const runs: { col: number; width: number }[] = [];
	let col = 0;
	let start = -1;
	for (const ch of plain) {
		if (ch === " ") {
			if (start >= 0) runs.push({ col: start, width: col - start });
			start = -1;
		} else if (start < 0) start = col;
		col += cellWidth(ch);
	}
	if (start >= 0) runs.push({ col: start, width: col - start });
	return runs;
}

/** Last SGR mouse report in a chunk of terminal input, zero-based cell coords. */
export function lastMousePosition(data: string): { x: number; y: number } | undefined {
	let hit: { x: number; y: number } | undefined;
	for (const m of data.matchAll(/\x1b\[<(\d+);(\d+);(\d+)[Mm]/g)) {
		hit = { x: Number(m[2]) - 1, y: Number(m[3]) - 1 };
	}
	return hit;
}

/** Menu-bar model name: "Claude Opus 5.5" -> "opus5.5", "Grok 4.7" -> "grok4.7". */
export function shortModel(name: string): string {
	return name
		.toLowerCase()
		.replace(/\(.*?\)/g, "")
		.replace(/^(claude|anthropic|openai|xai|google)[\s/:-]+/, "")
		.replace(/[\s_-]+/g, "");
}

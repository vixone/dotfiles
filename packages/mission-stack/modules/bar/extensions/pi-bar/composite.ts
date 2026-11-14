/**
 * Background-preserving compositing for the ghost HUD.
 *
 * pi's compositeTuiLine resets styles before an overlay, so every HUD cell
 * drops to the terminal's default background and punches a box into tool
 * output or message panels. Here each opaque HUD piece is split where the base
 * line's background changes, and each part is re-painted with the background
 * that was under it. Only glyphs change; the panels underneath stay intact.
 */

export type Run = { col: number; width: number };
export type BgRun = Run & { bg: string };

// CSI (SGR and others), OSC (BEL or ST terminated), and APC/DCS/PM/SOS strings.
const ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_X][^\x1b]*\x1b\\/y;
const segmenter = new Intl.Segmenter();

/**
 * Next active background after applying one SGR parameter list. Returns the
 * escape that re-applies it, or "" for the terminal default.
 */
export function applySgr(bg: string, params: string): string {
	const p = params === "" ? [0] : params.split(/[;:]/).map((n) => (n === "" ? 0 : Number(n)));
	for (let i = 0; i < p.length; i++) {
		const n = p[i] ?? 0;
		if (n === 0 || n === 49) bg = "";
		else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) bg = `\x1b[${n}m`;
		else if (n === 48 || n === 38 || n === 58) {
			const kind = p[i + 1];
			const len = kind === 5 ? 2 : kind === 2 ? 4 : 1;
			if (n === 48) bg = `\x1b[48;${p.slice(i + 1, i + 1 + len).join(";")}m`;
			i += len;
		}
	}
	return bg;
}

/** Background runs of a styled line, by column, with the escape that paints each. */
export function backgroundRuns(line: string, cellWidth: (s: string) => number): BgRun[] {
	const runs: BgRun[] = [];
	let bg = "";
	let col = 0;
	const push = (width: number) => {
		const last = runs.at(-1);
		if (last && last.bg === bg) last.width += width;
		else runs.push({ col, width, bg });
		col += width;
	};
	let i = 0;
	let text = "";
	const flush = () => {
		for (const { segment } of segmenter.segment(text)) {
			const w = cellWidth(segment);
			if (w > 0) push(w);
		}
		text = "";
	};
	while (i < line.length) {
		ESCAPE.lastIndex = i;
		const m = line.charCodeAt(i) === 0x1b ? ESCAPE.exec(line) : null;
		if (!m) {
			text += line[i];
			i++;
			continue;
		}
		flush();
		const code = m[0];
		if (code.endsWith("m") && code.startsWith("\x1b[")) bg = applySgr(bg, code.slice(2, -1));
		i += code.length;
	}
	flush();
	return runs;
}

/** Background at a column; "" (default) past the end of the line. */
function bgAt(runs: readonly BgRun[], col: number): BgRun | undefined {
	return runs.find((r) => col >= r.col && col < r.col + r.width);
}

/** Split an absolute-column piece at every background change in the base. */
export function splitByBackground(piece: Run, runs: readonly BgRun[]): BgRun[] {
	const out: BgRun[] = [];
	let col = piece.col;
	const end = piece.col + piece.width;
	while (col < end) {
		const run = bgAt(runs, col);
		const stop = run ? Math.min(end, run.col + run.width) : end;
		out.push({ col, width: stop - col, bg: run?.bg ?? "" });
		col = stop;
	}
	return out;
}

/** Paint HUD text on a background, re-applying it after any reset inside. */
export function onBackground(text: string, bg: string): string {
	if (!bg) return text;
	return bg + text.replace(/\x1b\[(?:0|49)?m/g, (reset) => reset + bg);
}

/**
 * Draw a HUD line's glyph runs (relative to `col`) over `base`, each part on
 * the background it covers. Everything between runs keeps the base cells.
 */
export function compositeOver(
	base: string,
	line: string,
	runs: readonly Run[],
	col: number,
	total: number,
	tui: {
		composite: (base: string, overlay: string, col: number, width: number, total: number) => string;
		slice: (line: string, col: number, width: number) => string;
		cellWidth: (s: string) => number;
	},
): string {
	const bgs = backgroundRuns(base, tui.cellWidth);
	let out = base;
	for (const run of runs) {
		for (const part of splitByBackground({ col: col + run.col, width: run.width }, bgs)) {
			const text = onBackground(tui.slice(line, part.col - col, part.width), part.bg);
			out = tui.composite(out, text, part.col, part.width, total);
		}
	}
	return out;
}

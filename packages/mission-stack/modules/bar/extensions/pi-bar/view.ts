/**
 * HUD component, macOS menu-bar style: one right-aligned line with the
 * model, context bar and cost. Hover, or pin with ctrl+\, to drop down a detail
 * panel (model, dir, git, cache, tok/s graph, status rows).
 *
 * See-through: ASCII spaces are transparent. The view records the glyph runs
 * of each line it returns, and index.ts composites only those over the
 * transcript, on the background that was under them.
 *
 * Glyphs use the theme's semantic colors, mixed toward the background by
 * (1 - opacity) so they read as part of the terminal. Hovering shows them at
 * full strength.
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	foregroundAnsi,
	mixColors,
	rgbColor,
	truncateToWidth,
	visibleWidth,
	type Color,
	type Component,
} from "@earendil-works/pi-tui";

import { barCells, brailleGraph, compact, opaqueRuns, quantile, shortModel, type GitInfo } from "./graph.ts";
import { stripAnsi, type StatusRow } from "./status.ts";

export type HudViewOptions = {
	theme: Theme;
	data: () => HudData;
	/** Glyph opacity, 0-1. 1 is the plain theme color. */
	opacity: () => number;
	/** Detail panel pinned open (ctrl+\); hover also opens it. */
	expanded: () => boolean;
};

type Paint = (color: ThemeColor | Color, text: string) => string;

export type HudData = {
	model: string;
	thinking: string;
	dir: string;
	git: GitInfo | undefined;
	ctx: { tokens: number | null; window: number; percent: number | null } | undefined;
	cost: number;
	cacheRead: number;
	rate: { samples: readonly number[]; current: number; peak: number; lastAvg: number | undefined; running: boolean };
	rows: readonly StatusRow[];
};

export type Piece = { col: number; width: number };

const GRAPH_ROWS = 2;
/** Context bar segments on the menu line, battery style. */
const CTX_SEGMENTS = 10;
/** Absolute context warning, including models with large context windows. */
const CTX_WARN_TOKENS = 150_000;
const CTX_ORANGE = rgbColor(255, 165, 0);
/** Narrow (non-emoji) glyph so WezTerm and pi agree on its width. */
const CACHE_ICON = "↺";
/** What faded glyphs mix toward; the real per-cell background is not known here. */
const DARK_BG = rgbColor(20, 20, 28);
const LIGHT_BG = rgbColor(245, 245, 245);

const THINKING_COLOR: Record<string, ThemeColor> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

export class HudView implements Component {
	private hovered = false;
	private pieces = new Map<string, Piece[]>();
	private readonly opts: HudViewOptions;

	constructor(opts: HudViewOptions) {
		this.opts = opts;
	}

	setHovered(hovered: boolean): boolean {
		if (this.hovered === hovered) return false;
		this.hovered = hovered;
		return true;
	}

	/** Opaque pieces for a line this view rendered last frame, else undefined. */
	piecesFor(line: string): Piece[] | undefined {
		return this.pieces.get(line);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const paint = painter(this.opts.theme, this.hovered ? 1 : this.opts.opacity());
		const lines = [this.menuLine(paint)];
		if (this.hovered || this.opts.expanded()) lines.push(paint("borderMuted", "─".repeat(width)), ...this.panel(width, paint));
		// Everything hugs the right edge, menu-bar style.
		const out = lines.map((l) => {
			const t = truncateToWidth(l, width, "…");
			return " ".repeat(Math.max(0, width - visibleWidth(t))) + t;
		});
		this.pieces = new Map(out.map((line) => [line, opaqueRuns(stripAnsi(line), visibleWidth)]));
		return out;
	}

	/** The menu line alone, right-aligned, for the footer of a narrow terminal. */
	footerLine(width: number): string {
		const line = truncateToWidth(this.menuLine(painter(this.opts.theme, this.opts.opacity())), width, "…");
		return " ".repeat(Math.max(0, width - visibleWidth(line))) + line;
	}

	/** Menu-bar line: short model name, context bar, tokens used/window, session cost. */
	private menuLine(paint: Paint): string {
		const d = this.opts.data();
		const parts: string[] = [paint("accent", shortModel(d.model))];
		if (d.ctx && d.ctx.percent !== null && d.ctx.tokens !== null) {
			const pct = d.ctx.percent;
			const { filled, empty } = barCells(pct, CTX_SEGMENTS);
			const color: ThemeColor | Color = pct >= 80 ? "error" : d.ctx.tokens >= CTX_WARN_TOKENS ? CTX_ORANGE : pct >= 50 ? "warning" : "success";
			parts.push(
				paint(color, "▰".repeat(filled)) +
					paint("borderMuted", "▱".repeat(empty)) +
					" " +
					paint("text", `${compact(d.ctx.tokens)}/${compact(d.ctx.window)}`),
			);
		} else {
			parts.push(paint("borderMuted", "▱".repeat(CTX_SEGMENTS)) + " " + paint("dim", "ctx --"));
		}
		if (d.cost > 0) parts.push(paint("success", `$${d.cost.toFixed(2)}`));
		return parts.join(" ");
	}

	/** Detail panel shown under the menu line while expanded or hovered. */
	private panel(width: number, paint: Paint): string[] {
		const d = this.opts.data();
		const join = (parts: string[]) => parts.filter(Boolean).join(" ");
		const row = (label: string, value: string) => (label ? `${paint("muted", label)} ${value}` : value);

		const lines: string[] = [];
		lines.push(row("model", join([paint("accent", d.model), paint(THINKING_COLOR[d.thinking] ?? "muted", d.thinking)])));
		lines.push(row("dir", paint("text", d.dir)));
		const g = d.git;
		lines.push(
			row(
				"git",
				g
					? join([
							paint("warning", g.branch),
							g.dirty ? paint("warning", `*${g.dirty}`) : "",
							g.untracked ? paint("muted", `?${g.untracked}`) : "",
							g.ahead ? paint("success", `↑${g.ahead}`) : "",
							g.behind ? paint("error", `↓${g.behind}`) : "",
						])
					: paint("dim", "-"),
			),
		);
		lines.push(row(CACHE_ICON, paint("accent", `${compact(d.cacheRead)} cached`)));
		const r = d.rate;
		lines.push(
			row(
				"tok/s",
				join([
					r.running ? paint("accent", `${Math.round(r.current)}`) : paint("dim", "idle"),
					r.lastAvg !== undefined ? paint("muted", `avg ${Math.round(r.lastAvg)}`) : "",
					r.peak > 0 ? paint("muted", `pk ${Math.round(r.peak)}`) : "",
				]),
			),
		);
		// Scale to the 95th percentile so one burst does not flatten the rest.
		const recent = r.samples.slice(-width * 2);
		const scale = Math.max(20, quantile(recent, 0.95) * 1.15);
		const padded = recent.length >= width * 2 ? recent : [...new Array<number>(width * 2 - recent.length).fill(0), ...recent];
		for (const line of brailleGraph(padded, width, GRAPH_ROWS, scale)) lines.push(paint("accent", line));

		for (const s of d.rows) {
			lines.push(row(s.label, join(s.parts.map((p) => paint(p.tone, p.text)))));
		}
		return lines;
	}
}

/**
 * Paint text in a theme color at the given opacity: the color mixed toward
 * the background by (1 - opacity). Falls back to the plain theme color when
 * the theme cannot resolve concrete colors.
 */
export function painter(theme: Theme, opacity: number): Paint {
	const plain: Paint = (color, text) => typeof color === "string"
		? theme.fg(color, text)
		: `${foregroundAnsi(color, theme.getColorMode())}${text}\x1b[39m`;
	if (opacity >= 1) return plain;
	const toward = theme.appearance === "light" ? LIGHT_BG : DARK_BG;
	const cache = new Map<ThemeColor | Color, string | undefined>();
	const open = (color: ThemeColor | Color): string | undefined => {
		if (cache.has(color)) return cache.get(color);
		let ansi: string | undefined;
		try {
			const base: Color | undefined = typeof color === "string" ? theme.colors[color] : color;
			if (base) ansi = foregroundAnsi(mixColors(base, toward, Math.min(1, Math.max(0, 1 - opacity))), theme.getColorMode());
		} catch {
			ansi = undefined;
		}
		cache.set(color, ansi);
		return ansi;
	};
	return (color, text) => {
		const ansi = open(color);
		return ansi ? `${ansi}${text}\x1b[39m` : plain(color, text);
	};
}

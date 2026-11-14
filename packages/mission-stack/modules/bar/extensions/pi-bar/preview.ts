/**
 * Prints the HUD with fake data over a fake transcript that has a coloured
 * panel, so the background passthrough is visible: `npx tsx preview.ts [opacity 0-1] [open]`.
 */
import { compositeTuiLine, foregroundAnsi, parseColor, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import { compositeOver } from "./composite.ts";
import { allStatusRows } from "./status.ts";
import { HudView, type HudData } from "./view.ts";

// Cyberpunk-ish palette, so the opacity mixing runs on concrete colors.
const HEX: Record<string, string> = {
	accent: "#00fff9", muted: "#8888aa", dim: "#555566", text: "#e0e0ff", warning: "#ffd700",
	success: "#39ff14", error: "#ff073a", borderMuted: "#444466", thinkingHigh: "#ff00ff",
};
const colors = Object.fromEntries(Object.entries(HEX).map(([k, v]) => [k, parseColor(v)]));
const theme = {
	appearance: "dark",
	colors,
	getColorMode: () => "truecolor",
	fg: (c: string, t: string) => `${foregroundAnsi(colors[c] ?? parseColor("#ff00ff"), "truecolor")}${t}\x1b[39m`,
} as unknown as Theme;

const samples = Array.from({ length: 76 }, (_, i) => (i < 20 ? 0 : 30 + 25 * Math.sin(i / 3) + (i % 7) * 4) * (i % 19 < 4 ? 0 : 1));
const data: HudData = {
	model: "Opus 5.5",
	thinking: "high",
	dir: "dotfiles",
	git: { branch: "main", ahead: 0, behind: 0, dirty: 1, untracked: 1 },
	ctx: { tokens: 110_000, window: 1_000_000, percent: 11 },
	cost: 4.12,
	cacheRead: 5_600_000,
	rate: { samples, current: 42, peak: 88, lastAvg: 38, running: true },
	rows: allStatusRows(
		new Map([
			["focus", "\x1b[36m🎯 xmu4 — OpenSearch POC and migration feasibility\x1b[0m"],
			["ops-mode", "ops"],
			["rig-autofresh", "ctx expert1 110k, expert2 56k (restarting)"],
			["rig-context", "context 162k > 150k: /continue"],
		]),
	),
};
const opacity = Number(process.argv[2] ?? 0.8);
const expanded = process.argv[3] === "open";
const view = new HudView({ theme, data: () => data, opacity: () => opacity, expanded: () => expanded });
const TOTAL = 80;
const COL = 34;
const text = "The graph plots tokens per second during streaming, sampled 4 times a second.";
// Rows 3-9 sit inside a blue panel (like a user message), the rest on the default bg.
const baseFor = (i: number) => (i >= 3 && i <= 9 ? `\x1b[44m ${text.padEnd(TOTAL - 1)}\x1b[49m` : text);
const ops = { composite: compositeTuiLine, slice: (l: string, c: number, w: number) => sliceByColumn(l, c, w, true), cellWidth: visibleWidth };
view.render(42).forEach((line, i) => {
	const runs = view.piecesFor(line);
	const base = baseFor(i);
	console.log(compositeOver(base, line, runs ?? [], COL, TOTAL, ops));
});

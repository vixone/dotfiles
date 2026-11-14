import assert from "node:assert/strict";
import { it } from "node:test";

import { compositeTuiLine, foregroundAnsi, parseColor, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

import { applySgr, backgroundRuns, compositeOver, onBackground, splitByBackground } from "./composite.ts";
import { barCells, brailleGraph, compact, lastMousePosition, NBSP, opaqueRuns, parseGitStatus, quantile, shortModel, sparkline } from "./graph.ts";
import { allStatusRows, statusRows, stripAnsi } from "./status.ts";
import { HudView, painter, type HudData, type HudViewOptions } from "./view.ts";
import { DEFAULT_OPACITY } from "./index.ts";

// Graph: flat zero line sits on the bottom dot row; history fills from the right.
assert.deepEqual(brailleGraph([0, 0], 2, 1, 10), [" ⣀"]);
assert.deepEqual(brailleGraph([10, 10, 10, 10], 2, 1, 10), ["⠉⠉"]);
// A jump from 0 to max joins with a vertical run in the second column.
assert.deepEqual(brailleGraph([0, 10], 1, 1, 10), ["⣸"]);
assert.equal(brailleGraph([5], 4, 2, 10).length, 2);
assert.equal(brailleGraph(new Array(100).fill(3), 4, 2, 10)[0]?.length, 4);

assert.equal(sparkline([0, 50, 100], 3, 100), "▁▅█");
assert.equal(sparkline([1, 2, 3, 4], 2, 4), "▆█");

assert.deepEqual(barCells(50, 10), { filled: 5, empty: 5 });
assert.deepEqual(barCells(150, 10), { filled: 10, empty: 0 });

assert.equal(compact(950), "950");
assert.equal(compact(1234), "1.2k");
assert.equal(compact(110_000), "110k");
assert.equal(compact(1_000_000), "1.0M");

assert.deepEqual(parseGitStatus("## main...origin/main [ahead 2, behind 1]\n M a.ts\n?? b.ts\n?? c.ts\n"), {
	branch: "main",
	ahead: 2,
	behind: 1,
	dirty: 1,
	untracked: 2,
});
assert.deepEqual(parseGitStatus("## feature/x\n"), { branch: "feature/x", ahead: 0, behind: 0, dirty: 0, untracked: 0 });
assert.equal(parseGitStatus("fatal: not a git repository"), undefined);

assert.deepEqual(lastMousePosition("\x1b[<35;10;5M\x1b[<35;12;6M"), { x: 11, y: 5 });
assert.equal(lastMousePosition("hello"), undefined);

// See-through: ASCII spaces split opaque runs, NBSP does not.
assert.deepEqual(opaqueRuns(`ab${NBSP}c  d `, () => 1), [{ col: 0, width: 4 }, { col: 6, width: 1 }]);
assert.deepEqual(opaqueRuns("   ", () => 1), []);
assert.equal(quantile([1, 2, 3, 100], 0.5), 3);
assert.equal(quantile([], 0.9), 0);

assert.equal(stripAnsi("\x1b[36mhi\x1b[0m"), "hi");
assert.deepEqual(statusRows("focus", "\x1b[36m🎯 xmu4 — OpenSearch POC\x1b[0m"), [
	{ label: "focus", parts: [{ text: "xmu4", tone: "accent" }, { text: "OpenSearch POC", tone: "text" }] },
]);
assert.deepEqual(statusRows("rig-autofresh", "ctx expert1 110k, expert2 56k (restarting)"), [
	{ label: "rig", parts: [{ text: "expert1", tone: "text" }, { text: "110k", tone: "accent" }] },
	{ label: "", parts: [{ text: "expert2", tone: "text" }, { text: "56k", tone: "accent" }, { text: "restarting", tone: "warning" }] },
]);
assert.equal(statusRows("rig-autofresh", "ctx (autofresh off) expert1 9k").at(-1)?.parts[0]?.text, "autofresh off");
assert.deepEqual(statusRows("advisor", ""), []);
assert.deepEqual(
	allStatusRows(new Map([["zzz", "x"], ["ops-mode", "ops"], ["focus", "🎯 a1"]])).map((r) => r.label),
	["focus", "mode", "zzz"],
);

// Text rows split at every space, so only glyphs are opaque.
{
	const painted: { color: string; text: string }[] = [];
	const theme = {
		fg: (color: string, text: string) => { painted.push({ color, text }); return text; },
		getColorMode: () => "truecolor",
	} as unknown as HudViewOptions["theme"];
	const data: HudData = {
		model: "Opus 5.5",
		thinking: "high",
		dir: "repo",
		git: undefined,
		ctx: undefined,
		cost: 0,
		cacheRead: 0,
		rate: { samples: [], current: 0, peak: 0, lastAvg: undefined, running: false },
		rows: [],
	};
	let expanded = false;
	const view = new HudView({ theme, data: () => data, opacity: () => 0.8, expanded: () => expanded });
	// Collapsed: one right-aligned menu line; cost and context only.
	const [menu = "", ...rest] = view.render(42);
	assert.equal(rest.length, 0);
	assert.equal(visibleWidth(menu), 42);
	assert.ok(menu.endsWith("opus5.5 ▱▱▱▱▱▱▱▱▱▱ ctx --"));
	assert.equal(shortModel("Claude Opus 5.5"), "opus5.5");
	assert.equal(shortModel("Grok 4.7"), "grok4.7");
	assert.equal(shortModel("GPT-5.5 (high)"), "gpt5.5");
	data.cost = 1.5;
	data.ctx = { tokens: 310_000, window: 1_000_000, percent: 31 };
	assert.ok(stripAnsi(view.render(42)[0] ?? "").endsWith(" opus5.5 ▰▰▰▱▱▱▱▱▱▱ 310k/1.0M $1.50"));
	const foot = view.footerLine(50);
	assert.equal(visibleWidth(foot), 50);
	assert.ok(stripAnsi(foot).endsWith("opus5.5 ▰▰▰▱▱▱▱▱▱▱ 310k/1.0M $1.50"));
	assert.equal(visibleWidth(view.footerLine(20)), 20);
	// Expanded: rule, then the panel, right-aligned, with only glyphs opaque.
	expanded = true;
	const lines = view.render(42);
	const [, rule = "", modelLine = "", dirLine = ""] = lines;
	assert.equal(rule, "─".repeat(42));
	assert.deepEqual(view.piecesFor(modelLine), [{ col: 23, width: 5 }, { col: 29, width: 4 }, { col: 34, width: 3 }, { col: 38, width: 4 }]);
	assert.deepEqual(view.piecesFor(dirLine), [{ col: 34, width: 3 }, { col: 38, width: 4 }]);
	assert.ok(lines.every((l) => visibleWidth(l) === 42));
	// Hover opens it too.
	expanded = false;
	view.setHovered(true);
	assert.equal(view.render(42).length, lines.length);
	assert.ok(!lines.some((l) => l.includes(NBSP)));

	it("warns in orange from 150k inclusive, independent of context-window size", () => {
		const orange = "\x1b[38;2;255;165;0m";
		const full = new HudView({ theme, data: () => data, opacity: () => 1, expanded: () => false });
		for (const window of [200_000, 500_000, 1_000_000]) {
			for (const tokens of [149_999, 150_000, 150_001]) {
				data.ctx = { tokens, window, percent: tokens / window * 100 };
				for (const render of [() => full.render(42)[0] ?? "", () => full.footerLine(50)]) {
					const line = render();
					assert.equal(line.includes(orange), tokens >= 150_000, `${tokens}/${window}`);
					assert.ok(visibleWidth(line) <= 50);
				}
			}
		}
		// Below the absolute warning, the existing percentage-based warning remains.
		data.ctx = { tokens: 100_000, window: 200_000, percent: 50 };
		painted.length = 0;
		full.render(42);
		assert.ok(painted.some((p) => p.color === "warning" && p.text.includes("▰")));
		// Critical window pressure still takes priority over the orange warning.
		data.ctx = { tokens: 800_000, window: 1_000_000, percent: 80 };
		painted.length = 0;
		assert.ok(!full.footerLine(50).includes(orange));
		assert.ok(painted.some((p) => p.color === "error" && p.text.includes("▰")));
		// Unknown context is not treated as an orange warning.
		data.ctx = { tokens: null, window: 1_000_000, percent: null };
		assert.ok(!full.footerLine(50).includes(orange));
	});
}

it("starts at full opacity without a /pibar 100 command", () => {
	assert.equal(DEFAULT_OPACITY, 1);
});

// Opacity mixes the theme color toward the background; 1 is the plain color.
{
	const colors = { accent: parseColor("#00ff00") };
	let colorMode: "truecolor" | "256color" = "truecolor";
	const theme = {
		appearance: "dark",
		colors,
		getColorMode: () => colorMode,
		fg: (_c: string, t: string) => `<fg>${t}`,
	} as unknown as HudViewOptions["theme"];
	assert.equal(painter(theme, 1)("accent", "x"), "<fg>x");
	const faded = painter(theme, 0.7)("accent", "x");
	assert.match(faded, /^\x1b\[38;2;\d+;\d+;\d+mx\x1b\[39m$/);
	assert.notEqual(faded, `${foregroundAnsi(colors.accent, "truecolor")}x\x1b[39m`);
	// Unknown token: plain theme color.
	assert.equal(painter(theme, 0.7)("error", "x"), "<fg>x");
	// The absolute context warning stays orange across themes and obeys opacity and terminal capabilities.
	const orange = parseColor("#ffa500");
	const fullOrange = `${foregroundAnsi(orange, "truecolor")}x\x1b[39m`;
	assert.equal(painter(theme, 1)(orange, "x"), fullOrange);
	assert.notEqual(painter(theme, 0.7)(orange, "x"), fullOrange);
	colorMode = "256color";
	assert.equal(painter(theme, 1)(orange, "x"), `${foregroundAnsi(orange, "256color")}x\x1b[39m`);
}

// Composite: HUD glyphs take the background that was under them.
{
	assert.equal(applySgr("", "48;2;1;2;3"), "\x1b[48;2;1;2;3m");
	assert.equal(applySgr("\x1b[44m", "38;2;1;2;3"), "\x1b[44m");
	assert.equal(applySgr("\x1b[44m", "0"), "");
	assert.equal(applySgr("", "1;104"), "\x1b[104m");
	const base = "ab\x1b[44mcd\x1b]8;;x\x07ef\x1b[49mgh";
	assert.deepEqual(backgroundRuns(base, visibleWidth), [
		{ col: 0, width: 2, bg: "" },
		{ col: 2, width: 4, bg: "\x1b[44m" },
		{ col: 6, width: 2, bg: "" },
	]);
	assert.deepEqual(
		splitByBackground({ col: 1, width: 8 }, backgroundRuns(base, visibleWidth)).map((r) => [r.col, r.width, r.bg]),
		[[1, 1, ""], [2, 4, "\x1b[44m"], [6, 2, ""], [8, 1, ""]],
	);
	assert.equal(onBackground("x\x1b[0my", "\x1b[44m"), "\x1b[44mx\x1b[0m\x1b[44my");
	assert.equal(onBackground("x", ""), "x");
	const ops = { composite: compositeTuiLine, slice: (l: string, c: number, w: number) => sliceByColumn(l, c, w, true), cellWidth: visibleWidth };
	const out = compositeOver("\x1b[44m" + "........" + "\x1b[49m", "X  Y", [{ col: 0, width: 1 }, { col: 3, width: 1 }], 2, 8, ops);
	assert.equal(stripAnsi(out).replace(/\]8;;/g, ""), "..X..Y..");
	assert.ok(out.includes("\x1b[44mX") && out.includes("\x1b[44mY"));
}

console.log("pi-bar ok");

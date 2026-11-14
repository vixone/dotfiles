/**
 * pi-bar: an FPS-overlay style HUD pinned to the top-right corner.
 *
 * Shows model, thinking level, dir, git, context usage, cache reads and cost, a braille
 * graph of streaming tokens/s, and every footer status (mission focus, ops
 * mode, rig seat context, ...). It is a non-capturing overlay, so the editor
 * keeps keyboard focus, and its blank cells are see-through.
 *
 * The HUD replaces pi's footer. While it is visible the footer is empty, or
 * just the menu line below MIN_OVERLAY_COLS, where the overlay hides. The HUD
 * reads extension statuses from the footer data provider, so it also sees
 * statuses set before pi-bar loaded. Hiding the HUD restores the built-in
 * footer.
 *
 * Menu-bar style: one line (model, context bar, cost) in the top-right. Hover
 * or ctrl+\ drops down the detail panel. Only glyphs cover the transcript, in
 * theme colors at reduced opacity (full while the mouse is over the HUD).
 *   /pibar [open|close|on|off|demo|<opacity 10-100>]   ctrl+\ pins the panel
 *
 * Extending: any extension can add a row through the shared event bus:
 *   pi.events.emit("pibar:set", { id: "deploy", label: "deploy", text: "live 3/4" })
 *   pi.events.emit("pibar:set", { id: "deploy" })   // remove the row
 *
 * Env: PI_BAR_DISABLED=1 turns it off.
 */
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { compositeTuiLine, sliceByColumn, visibleWidth, type OverlayHandle, type OverlayOptions, type TUI } from "@earendil-works/pi-tui";
import { basename } from "node:path";

import { compositeOver } from "./composite.ts";
import { lastMousePosition, parseGitStatus, type GitInfo } from "./graph.ts";
import { allStatusRows, type StatusRow } from "./status.ts";
import { HudView, type HudData } from "./view.ts";

const TUI_OPS = {
	composite: compositeTuiLine,
	slice: (line: string, col: number, width: number) => sliceByColumn(line, col, width, true),
	cellWidth: visibleWidth,
};
const TICK_MS = 250;
const MAX_SAMPLES = 400;
const CHARS_PER_TOKEN = 4;
const HUD_WIDTH = 42;
/** Narrower terminals (split herdr panes) get the menu line in the footer instead of the overlay. */
const MIN_OVERLAY_COLS = 60;
/** Full glyph opacity by default; /pibar 10-100 can lower it for this session. */
export const DEFAULT_OPACITY = 1;
const SEGMENT_TOPIC = "pibar:set";
const COMPOSITE = "compositeLineAt";
/** /pibar demo: sample statuses in the shape the real extensions emit. HUD only. */
const DEMO_STATUSES: readonly [string, string][] = [
	["focus", "🎯 xmu4 — OpenSearch POC and migration feasibility"],
	["ops-mode", "ops"],
	["rig-autofresh", "ctx expert1 110k, expert2 56k (restarting)"],
	["rig-context", "context 162k > 150k: /continue"],
];

type Segment = { label: string; text: string };
type Composite = (base: string, line: string, col: number, width: number, total: number) => string;

function parseSegment(data: unknown): { id: string; segment: Segment | undefined } | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const id = "id" in data && typeof data.id === "string" ? data.id : undefined;
	if (!id) return undefined;
	const text = "text" in data && typeof data.text === "string" ? data.text : undefined;
	const label = "label" in data && typeof data.label === "string" ? data.label : id;
	return { id, segment: text === undefined ? undefined : { label, text } };
}

export default function piBar(pi: ExtensionAPI): void {
	if (process.env.PI_BAR_DISABLED === "1") return;

	let shown = true;
	let pinned = false;
	let opacity = DEFAULT_OPACITY;
	let latest: ExtensionContext | undefined;
	let tui: TUI | undefined;
	let view: HudView | undefined;
	let handle: OverlayHandle | undefined;
	let close: (() => void) | undefined;
	let unsubInput: (() => void) | undefined;
	let unpatch: (() => void) | undefined;
	let ui: ExtensionUIContext | undefined;
	let footerData: ReadonlyFooterDataProvider | undefined;

	let git: GitInfo | undefined;
	let gitAt = 0;
	const samples: number[] = [];
	let pendingChars = 0;
	let running = false;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let msgStart: number | undefined;
	let lastAvg: number | undefined;
	const segments = new Map<string, Segment>();
	let demo = false;

	const render = () => tui?.requestRender();

	const usageTotals = (ctx: ExtensionContext) => {
		let cost = 0;
		let cacheRead = 0;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			cost += entry.message.usage.cost.total;
			cacheRead += entry.message.usage.cacheRead;
		}
		return { cost, cacheRead };
	};

	const snapshot = (): HudData => {
		const ctx = latest;
		const usage = ctx?.getContextUsage();
		const visible = samples.slice(-HUD_WIDTH * 2);
		const last = samples.slice(-4);
		const statuses = footerData?.getExtensionStatuses() ?? new Map<string, string>();
		const rows: StatusRow[] = [
			...allStatusRows(demo ? new Map([...statuses, ...DEMO_STATUSES]) : statuses),
			...[...segments.values()].map((s): StatusRow => ({ label: s.label, parts: [{ text: s.text, tone: "text" }] })),
		];
		const totals = ctx ? usageTotals(ctx) : { cost: 0, cacheRead: 0 };
		return {
			model: ctx?.model?.name ?? ctx?.model?.id ?? "no model",
			thinking: pi.getThinkingLevel(),
			dir: ctx ? basename(ctx.cwd) : "",
			git,
			ctx: usage ? { tokens: usage.tokens, window: usage.contextWindow, percent: usage.percent } : undefined,
			cost: totals.cost,
			cacheRead: totals.cacheRead,
			rate: {
				samples,
				current: last.length ? last.reduce((a, b) => a + b, 0) / last.length : 0,
				peak: visible.length ? Math.max(...visible) : 0,
				lastAvg,
				running,
			},
			rows,
		};
	};

	const refreshGit = async (ctx: ExtensionContext, force = false) => {
		if (!force && Date.now() - gitAt < 2000) return;
		gitAt = Date.now();
		const res = await pi.exec("git", ["-C", ctx.cwd, "status", "--porcelain=v1", "-b"], { timeout: 3000 });
		git = res.code === 0 ? parseGitStatus(res.stdout) : undefined;
		render();
	};

	/**
	 * While the HUD is up, pi's footer is an empty component; the HUD shows its
	 * content. Hidden or closed, the built-in footer comes back.
	 */
	const syncFooter = () => {
		if (!ui) return;
		if (shown && close) {
			ui.setFooter((_t, _theme, data) => {
				footerData = data;
				return {
					render: (width: number) => (width >= MIN_OVERLAY_COLS || !view ? [] : [view.footerLine(width)]),
					invalidate: () => {},
				};
			});
		} else ui.setFooter(undefined);
	};

	const setShown = (next: boolean) => {
		shown = next;
		handle?.setHidden(!shown);
		syncFooter();
		render();
	};

	/**
	 * See-through compositing: for lines this HUD rendered, draw only their
	 * opaque pieces over the base line, each on the background it covers.
	 * Other overlays use pi's compositor.
	 * Relies on TUI's internal compositeLineAt; falls back to opaque if absent.
	 */
	const patchCompositor = (t: TUI) => {
		const original: unknown = Reflect.get(t, COMPOSITE);
		if (typeof original !== "function") return;
		const fallback: Composite = (base, line, col, width, total) => Reflect.apply(original, t, [base, line, col, width, total]);
		const transparent: Composite = (base, line, col, width, total) => {
			const pieces = view?.piecesFor(line);
			if (!pieces) return fallback(base, line, col, width, total);
			return compositeOver(base, line, pieces, col, total, TUI_OPS);
		};
		Reflect.set(t, COMPOSITE, transparent);
		unpatch = () => Reflect.deleteProperty(t, COMPOSITE);
	};

	const open = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui" || close) return;
		const options: OverlayOptions = {
			anchor: "top-right",
			width: HUD_WIDTH,
			margin: { top: 1, right: 2 },
			nonCapturing: true,
			visible: (cols) => cols >= MIN_OVERLAY_COLS,
		};
		void ctx.ui.custom<void>(
			(t, theme, _kb, done) => {
				tui = t;
				close = () => done();
				view = new HudView({
					theme,
					data: snapshot,
					opacity: () => opacity,
					expanded: () => pinned,
				});
				patchCompositor(t);
				return view;
			},
			{
				overlay: true,
				overlayOptions: options,
				onHandle: (h) => {
					handle = h;
					h.setHidden(!shown);
					syncFooter();
				},
			},
		);
		// Raw input sees every SGR mouse report before pi routes it, so hover
		// enter and leave are both observable. Never consumes input.
		unsubInput = ctx.ui.onTerminalInput((data) => {
			const pos = lastMousePosition(data);
			const b = handle?.getBounds();
			if (!pos || !view) return undefined;
			const inside = !!b && pos.x >= b.col && pos.x < b.col + b.width && pos.y >= b.row && pos.y < b.row + b.height;
			if (view.setHovered(inside)) render();
			return undefined;
		});
	};

	const teardown = () => {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		unsubInput?.();
		unsubInput = undefined;
		unpatch?.();
		unpatch = undefined;
		close?.();
		close = undefined;
		syncFooter();
		handle = undefined;
		view = undefined;
		tui = undefined;
	};

	pi.events.on(SEGMENT_TOPIC, (data) => {
		const parsed = parseSegment(data);
		if (!parsed) return;
		if (parsed.segment) segments.set(parsed.id, parsed.segment);
		else segments.delete(parsed.id);
		render();
	});

	pi.on("session_start", async (_e, ctx) => {
		latest = ctx;
		samples.length = 0;
		lastAvg = undefined;
		if (ctx.hasUI) ui = ctx.ui;
		open(ctx);
		await refreshGit(ctx, true);
	});

	pi.on("session_shutdown", async () => teardown());

	pi.on("agent_start", async (_e, ctx) => {
		latest = ctx;
		running = true;
		if (!ticker) {
			ticker = setInterval(() => {
				samples.push(pendingChars / CHARS_PER_TOKEN / (TICK_MS / 1000));
				if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
				pendingChars = 0;
				render();
			}, TICK_MS);
		}
	});

	pi.on("agent_end", async (_e, ctx) => {
		latest = ctx;
		running = false;
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		await refreshGit(ctx, true);
	});

	pi.on("message_update", async (e) => {
		const ev = e.assistantMessageEvent;
		if (ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "toolcall_delta") {
			msgStart ??= Date.now();
			pendingChars += ev.delta.length;
		}
	});

	pi.on("message_end", async (e, ctx) => {
		latest = ctx;
		if (e.message.role === "assistant" && msgStart !== undefined) {
			const secs = (Date.now() - msgStart) / 1000;
			if (secs > 0.5 && e.message.usage.output > 0) lastAvg = e.message.usage.output / secs;
		}
		msgStart = undefined;
		render();
	});

	pi.on("turn_end", async (_e, ctx) => {
		latest = ctx;
		await refreshGit(ctx);
	});

	pi.on("model_select", async (_e, ctx) => {
		latest = ctx;
		render();
	});
	pi.on("thinking_level_select", async () => render());

	const togglePanel = (next: boolean) => {
		pinned = next;
		setShown(true);
	};

	pi.registerCommand("pibar", {
		description: "pi-bar HUD: open | close | on | off | demo | <opacity 10-100>",
		handler: async (args, ctx) => {
			latest = ctx;
			const arg = args.trim();
			const pct = Number(arg);
			if (!close) open(ctx);
			if (arg === "on" || arg === "off") setShown(arg === "on");
			else if (arg === "open" || arg === "close" || arg === "") togglePanel(arg === "" ? !pinned : arg === "open");
			else if (arg === "demo") {
				demo = !demo;
				render();
			} else if (arg !== "" && Number.isFinite(pct) && pct >= 10 && pct <= 100) {
				opacity = pct / 100;
				setShown(true);
			} else {
				ctx.ui.notify("usage: /pibar [open|close|on|off|demo|10-100]", "warning");
				return;
			}
			const state = shown ? `${pinned ? "open" : "line"}, opacity ${Math.round(opacity * 100)}%` : "off";
			ctx.ui.notify(`pi-bar: ${state}${demo ? " (demo rows on)" : ""}`, "info");
		},
	});

	// Single control byte (0x1c): survives herdr and needs no Alt/Option.
	pi.registerShortcut("ctrl+\\", {
		description: "Open or close the pi-bar detail panel",
		handler: async (ctx) => {
			latest = ctx;
			if (!close) open(ctx);
			togglePanel(!pinned);
		},
	});
}

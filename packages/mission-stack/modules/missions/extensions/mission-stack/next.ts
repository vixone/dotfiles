/**
 * continue
 *
 * `/continue [-e] [-r] [steering...]` (alias `/handover`): handover + fresh session in one command. Ask the agent for
 * a handover in ONE no-tool turn (cached transcript prefix, output tokens only), wrap it deterministically (opener +
 * body + repo facts), append a `## Context Snapshot` via `mx note` when a mission is focused, then open the new
 * session with that handover as the first prompt. No knowledge capture: `/land` (focus-land.ts) does that and stays
 * in the session.
 *
 * REUSE: a handover written in the last REUSE_MS (the run then stopped before the switch) seeds the new session
 * directly; `-r`/`--rewrite` or steering text writes a new one. While /continue runs it emits CONTINUE_EVENT so
 * context-budget does not compact (compaction aborts the handover turn), and it cancels Pi's own compaction except
 * overflow recovery.
 *
 * `-e` puts the first prompt in the editor instead of sending it. The new session gets the resolved focus
 * (`land-focus`), the model/thinking level (`next-carry`, restored by the new runtime's session_start) and Ops Mode
 * (`ops-mode`). Busy requests wait for idle with a queued notification; one request owns the whole workflow,
 * including the wait and session replacement.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { mxBin, openStore, type MissionReader } from "../../lib/mx-store.ts";

const FOCUS_ENTRY_TYPE = "land-focus";
const CARRY_ENTRY_TYPE = "next-carry";
const OPS_ENTRY_TYPE = "ops-mode";
const START_TIMEOUT_MS = 20_000;
const MAX_DIRTY_LINES = 15;

export type Focus = { id: string; title?: string } | null;

export type NextArgs = { edit: boolean; rewrite: boolean; steer: string };

export function parseNextArgs(raw: string): NextArgs {
	let edit = false;
	let rewrite = false;
	const rest: string[] = [];
	for (const tok of raw.trim().split(/\s+/).filter(Boolean)) {
		if (rest.length === 0 && (tok === "-e" || tok === "--edit")) edit = true;
		else if (rest.length === 0 && (tok === "-r" || tok === "--rewrite")) rewrite = true;
		else rest.push(tok);
	}
	return { edit, rewrite, steer: rest.join(" ") };
}

export function buildNextPrompt(steer: string): string {
	return [
		"/continue: write the handover a fresh session will start from. It replaces this whole conversation, so it must stand alone.",
		"",
		"Do not call tools. Reply with exactly one <handover>...</handover> block and nothing else.",
		"",
		"The first line inside the block must be exactly <mission>ID</mission> or <mission>none</mission>.",
		"- ID is the existing mission (mission-<id>) this work belongs to, only when you know it from this session.",
		"- Never invent an ID. Missions merely referenced, compared or used as prior art do not count.",
		"- If unsure or more than one fits, write <mission>none</mission>.",
		"",
		"Then, in this order, omit empty sections:",
		"## Goal - 1-2 lines. The outcome, not the activity.",
		"## State - done and verified; in flight; uncommitted edits by path.",
		"## Findings - decisions and facts learned, each with evidence (path:line, command, exact error).",
		"## Dead ends - what failed and why, so it is not retried.",
		"## Gotchas - env quirks the next session would waste turns rediscovering.",
		"## Next - numbered, ordered. Step 1 is concrete enough to start immediately.",
		"",
		"Rules:",
		"- Conclusions, not the journey. No transcripts, no file dumps, no recap of my prompts.",
		"- The next session already has the system prompt, AGENTS/CLAUDE files and skills. Do not repeat them.",
		"- Cite paths and line ranges instead of pasting code. Paste only exact strings that are hard to recover (errors, IDs, one-off commands).",
		"- Mark unverified claims as unverified.",
		"- Cut every line that does not change what the next session does. Aim for under 60 lines.",
		"- No opener line and no repo facts (cwd, branch, HEAD, dirty files). Both are added automatically.",
		...(steer ? ["", `Steering from the user (non-negotiable, trim elsewhere first): ${steer}`] : []),
	].join("\n");
}

export function extractHandover(text: string): string {
	const open = text.indexOf("<handover>");
	if (open === -1) return text.trim();
	const start = open + "<handover>".length;
	const close = text.indexOf("</handover>", start);
	return (close === -1 ? text.slice(start) : text.slice(start, close)).trim();
}

const MISSION_ID_RE = /^mission-[a-z0-9]+$/;
const MISSION_LINE_RE = /^\s*<\/?mission\b/i;

export type MissionMeta = { body: string; mission: string | null };

/**
 * Read the mission declaration from the FIRST line of the handover body only.
 * Strips that line. Malformed, `none`, or duplicated declarations yield null.
 * Bodies without a declaration (older handovers) pass through unchanged.
 */
export function parseMissionMeta(body: string): MissionMeta {
	const lines = body.split("\n");
	const firstIdx = lines.findIndex((l) => l.trim() !== "");
	if (firstIdx === -1 || !MISSION_LINE_RE.test(lines[firstIdx])) return { body, mission: null };
	const first = lines[firstIdx].trim();
	const rest = lines.slice(firstIdx + 1);
	const stripped = rest.join("\n").trim();
	if (rest.some((l) => MISSION_LINE_RE.test(l))) return { body: stripped, mission: null };
	const m = first.match(/^<mission>([^<>]*)<\/mission>$/);
	const value = m ? m[1].trim() : "";
	return { body: stripped, mission: MISSION_ID_RE.test(value) ? value : null };
}

/** Focus for an issue row; accept only the exact epic id. */
export function epicFocus(issue: { id?: unknown; issue_type?: unknown; title?: unknown } | null, id: string): Focus {
	if (!issue || issue.id !== id || issue.issue_type !== "epic") return null;
	const title = typeof issue.title === "string" && issue.title.trim() ? issue.title.trim() : undefined;
	return title ? { id, title } : { id };
}

/** Read the epic from mx.db in-process; any store error means "not a mission". */
export function lookupEpic(store: () => Pick<MissionReader, "showIssue">, id: string): Focus {
	try {
		return epicFocus(store().showIssue(id), id);
	} catch {
		return null;
	}
}

export function composeHandover(opts: { body: string; focus: Focus; cwd: string; repoFacts: string }): string {
	const { body, focus, cwd, repoFacts } = opts;
	const opener = focus
		? `Resume ${focus.id}${focus.title ? ` (${focus.title})` : ""} in ${cwd}. Handover from the previous session:`
		: `Continue in ${cwd}. Handover from the previous session:`;
	return [
		opener,
		"",
		body,
		...(repoFacts ? ["", "## Repo (at handover)", repoFacts] : []),
		"",
		"Start with step 1 of Next. Read referenced files only when a step needs them.",
	].join("\n");
}

export function getFocus(entries: unknown[]): Focus {
	const e = entries
		.filter((x: any) => x?.type === "custom" && x?.customType === FOCUS_ENTRY_TYPE)
		.pop() as { data?: Focus } | undefined;
	return e?.data ?? null;
}

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
// Record keys force this list to match pi's ThinkingLevel union.
const THINKING_LEVEL_SET: Record<ThinkingLevel, true> = {
	off: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true,
};
const isThinkingLevel = (v: unknown): v is ThinkingLevel => typeof v === "string" && Object.hasOwn(THINKING_LEVEL_SET, v);

export type Carry = { model: { provider: string; id: string } | null; thinkingLevel: ThinkingLevel };

function latestCustom(entries: unknown[], customType: string): unknown {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as { type?: unknown; customType?: unknown; data?: unknown } | null;
		if (e?.type === "custom" && e.customType === customType) return e.data;
	}
	return undefined;
}

export function parseCarry(data: unknown): Carry | null {
	if (typeof data !== "object" || data === null) return null;
	const thinkingLevel = "thinkingLevel" in data ? data.thinkingLevel : undefined;
	if (!isThinkingLevel(thinkingLevel)) return null;
	const m = "model" in data ? data.model : null;
	if (m === null) return { model: null, thinkingLevel };
	if (typeof m !== "object" || !("provider" in m) || !("id" in m)) return null;
	if (typeof m.provider !== "string" || typeof m.id !== "string") return null;
	return { model: { provider: m.provider, id: m.id }, thinkingLevel };
}

export function opsModeEnabled(entries: unknown[]): boolean {
	const data = latestCustom(entries, OPS_ENTRY_TYPE);
	return typeof data === "object" && data !== null && "enabled" in data && data.enabled === true;
}

type Exec = ExtensionAPI["exec"];

export async function gatherRepoFacts(exec: Exec, cwd: string): Promise<string> {
	const git = (args: string[]) => exec("git", ["-C", cwd, ...args], { timeout: 3000 }).catch(() => null);
	const [branch, head, status] = await Promise.all([
		git(["rev-parse", "--abbrev-ref", "HEAD"]),
		git(["log", "-1", "--oneline"]),
		git(["status", "--short"]),
	]);
	if (!branch || branch.code !== 0) return "";
	const lines = [`- branch: ${branch.stdout.trim()}`];
	if (head?.code === 0 && head.stdout.trim()) lines.push(`- HEAD: ${head.stdout.trim()}`);
	const dirty = status?.code === 0 ? status.stdout.split("\n").filter((l) => l.trim()) : [];
	if (dirty.length === 0) lines.push("- working tree clean");
	else {
		lines.push(`- dirty (${dirty.length}):`);
		for (const l of dirty.slice(0, MAX_DIRTY_LINES)) lines.push(`  ${l}`);
		if (dirty.length > MAX_DIRTY_LINES) lines.push(`  ... ${dirty.length - MAX_DIRTY_LINES} more`);
	}
	return lines.join("\n");
}

type Reply = { text: string; stopReason?: string; key: string; at: number };

const LEAN_PROMPT_RE = /^\/continue: write the handover/;
/** A handover this recent is reused by the next /continue instead of written again. */
export const REUSE_MS = 15 * 60_000;
/** Pi event bus topic: data `{ active: boolean }` while /continue owns the session. context-budget reads it. */
export const CONTINUE_EVENT = "mission-stack:continue";
const NOTED_ENTRY_TYPE = "continue-noted";

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	return (Array.isArray(content) ? content : []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");
}

const isUser = (e: any) => e?.type === "message" && e.message?.role === "user";

/**
 * The final reply to the prompt at entries[i]: the last assistant message before the next user message. A turn
 * that a later prompt started (a teammate message, an operator line) is never read as the handover.
 */
function replyAt(entries: unknown[], i: number): Reply | null {
	let reply: Reply | null = null;
	for (let j = i + 1; j < entries.length; j++) {
		const e = entries[j] as any;
		if (isUser(e)) break;
		if (e?.type !== "message" || e.message?.role !== "assistant") continue;
		const at = Date.parse(e.timestamp ?? "");
		reply = { text: messageText(e.message.content), stopReason: e.message.stopReason, key: String(e.id ?? e.timestamp ?? j), at };
	}
	return reply;
}

/** The reply to the latest prompt that matches re, or null when there is no such prompt. */
function replyToLatest(entries: unknown[], re: RegExp): Reply | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as any;
		if (isUser(e) && re.test(messageText(e.message.content))) return replyAt(entries, i);
	}
	return null;
}

const usable = (r: Reply | null): r is Reply => r !== null && r.stopReason === "stop" && r.text.trim() !== "";

export type RecentHandover = { reply: Reply; laterPrompts: number };

/**
 * The newest complete `<handover>` reply in this conversation written within maxAgeMs. laterPrompts counts the user
 * messages after it, which it does not cover. Pure.
 */
export function findRecentHandover(entries: unknown[], now: number, maxAgeMs: number = REUSE_MS): RecentHandover | null {
	let laterPrompts = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as any;
		if (!isUser(e)) continue;
		const text = messageText(e.message.content);
		if (LEAN_PROMPT_RE.test(text)) {
			const reply = replyAt(entries, i);
			const fresh = usable(reply) && Number.isFinite(reply.at) && now - reply.at <= maxAgeMs && now >= reply.at;
			if (fresh && reply.text.includes("<handover>")) return { reply, laterPrompts };
		}
		laterPrompts++;
	}
	return null;
}

function hasWork(entries: unknown[]): boolean {
	return entries.some((e: any) => e?.type === "message" && e.message?.role === "assistant");
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type NextDeps = { store?: () => Pick<MissionReader, "showIssue"> };

export function registerNext(pi: ExtensionAPI, deps: NextDeps = {}): void {
	const store = deps.store ?? (() => openStore());
	// Reserve the entire command, not only its handover turn.
	let active = false;
	// Resolved by agent_settled for the handover turn.
	let pending: { started: boolean; settle: (aborted: boolean) => void } | null = null;

	pi.on("agent_start", () => {
		if (pending) pending.started = true;
	});
	pi.on("agent_settled", (event) => {
		const p = pending;
		if (!p || !p.started) return;
		pending = null;
		p.settle(event.aborted);
	});
	// A compaction during /continue aborts the handover turn (session.compact() aborts first) and holds
	// waitForIdle for minutes. Only overflow recovery may run: without it the handover cannot fit at all.
	pi.on("session_before_compact", (event) => (active && event.reason !== "overflow" ? { cancel: true } : undefined));

	// Runs in the NEW runtime's instance of this extension, before withSession.
	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "new") return;
		const carry = parseCarry(latestCustom(ctx.sessionManager.getEntries(), CARRY_ENTRY_TYPE));
		if (!carry) return;
		const warn = (msg: string) => {
			if (ctx.hasUI) ctx.ui.notify(msg, "warning");
		};
		const want = carry.model;
		if (want && (ctx.model?.provider !== want.provider || ctx.model?.id !== want.id)) {
			const model = ctx.modelRegistry.find(want.provider, want.id);
			const label = `${want.provider}/${want.id}`;
			if (!model) warn(`/continue: model ${label} not found; using the default.`);
			else if (!(await pi.setModel(model))) warn(`/continue: no auth for ${label}; using the default.`);
		}
		// After setModel, which may adjust the level for the new model.
		pi.setThinkingLevel(carry.thinkingLevel);
	});

	const carryOf = (ctx: ExtensionCommandContext): Carry => ({
		model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
		thinkingLevel: pi.getThinkingLevel(),
	});

	/** Sends prompt as one turn and waits for it to settle. "never" when it did not start. */
	const runTurn = async (ctx: ExtensionCommandContext, prompt: string): Promise<"never" | "aborted" | "done"> => {
		const run = { started: false, settle: (_aborted: boolean) => {} };
		const settled = new Promise<boolean>((settle) => {
			run.settle = settle;
		});
		pending = run;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const startTimer = new Promise<"timeout">((r) => {
			timer = setTimeout(() => r("timeout"), START_TIMEOUT_MS);
		});
		pi.sendUserMessage(prompt);
		const first = await Promise.race([settled, startTimer]);
		clearTimeout(timer);
		if (first === "timeout" && !run.started) {
			pending = null;
			return "never";
		}
		const aborted = first === "timeout" ? await settled : first;
		// Let agent_settled emission finish before reading the reply or replacing the session.
		await delay(0);
		await ctx.waitForIdle();
		return aborted ? "aborted" : "done";
	};

	// Wraps a lean handover reply, notes it on the mission once, and opens the new session with it.
	const finishLean = async (ctx: ExtensionCommandContext, args: NextArgs, reply: Reply) => {
		const notify = (msg: string, level: "info" | "warning" | "error" = "info") => {
			if (ctx.hasUI) ctx.ui.notify(msg, level);
		};
		const entries = ctx.sessionManager.getEntries();
		const focus = getFocus(entries);
		const cwd = ctx.cwd;
		const parentSession = ctx.sessionManager.getSessionFile();
		const carry = carryOf(ctx);
		const ops = opsModeEnabled(entries);
		const meta = parseMissionMeta(extractHandover(reply.text));
		// Existing focus always wins; otherwise validate the declared mission.
		const resolved: Focus = focus ?? (meta.mission ? lookupEpic(store, meta.mission) : null);
		if (!focus && meta.mission && !resolved) notify(`/continue: ${meta.mission} is not a known mission epic; not focusing.`, "warning");
		const handover = composeHandover({ body: meta.body, focus: resolved, cwd, repoFacts: await gatherRepoFacts(pi.exec.bind(pi), cwd) });

		const noted = latestCustom(entries, NOTED_ENTRY_TYPE) as { key?: unknown } | undefined;
		if (resolved && noted?.key !== reply.key) {
			const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
			const note = `## Context Snapshot ${stamp} (/continue)\n\n${handover}`;
			const res = await pi.exec(mxBin(), ["note", resolved.id, note], { timeout: 8000 }).catch(() => null);
			if (!res || res.code !== 0) notify(`/continue: mx note on ${resolved.id} failed; continuing anyway.`, "warning");
			else pi.appendEntry(NOTED_ENTRY_TYPE, { key: reply.key });
		}

		const result = await ctx.newSession({
			parentSession,
			setup: async (sm) => {
				// Seed focus before the new runtime's session_start (focus-land restores it).
				if (resolved) sm.appendCustomEntry(FOCUS_ENTRY_TYPE, resolved);
				sm.appendCustomEntry(CARRY_ENTRY_TYPE, carry);
				if (ops) sm.appendCustomEntry(OPS_ENTRY_TYPE, { enabled: true });
			},
			withSession: async (next) => {
				if (args.edit) {
					next.ui.setEditorText(handover);
					next.ui.notify("Handover loaded in editor. Submit when ready.", "info");
				} else {
					// Do not await: prompt() resolves only after the whole run.
					next.sendUserMessage(handover).catch((err) => {
						next.ui.setEditorText(handover);
						next.ui.notify(`/continue: auto-send failed (${err instanceof Error ? err.message : err}). Handover is in the editor.`, "error");
					});
				}
			},
		});
		if (result.cancelled) notify("New session cancelled. Handover is the last message above.", "warning");
	};

	const runLeanHandover = async (ctx: ExtensionCommandContext, args: NextArgs) => {
		const notify = (msg: string, level: "info" | "warning" | "error" = "info") => {
			if (ctx.hasUI) ctx.ui.notify(msg, level);
		};
		notify("Writing handover...");
		const turn = await runTurn(ctx, buildNextPrompt(args.steer));
		if (turn === "never") return notify("/continue: handover turn never started (model/auth?).", "error");
		if (turn === "aborted") return notify("/continue cancelled. Run /continue again to reuse a finished handover.", "warning");
		const last = replyToLatest(ctx.sessionManager.getBranch(), LEAN_PROMPT_RE);
		if (!usable(last)) return notify("/continue: no handover text produced. Staying in this session.", "error");
		await finishLean(ctx, args, last);
	};

	const handler = async (rawArgs: string, ctx: ExtensionCommandContext) => {
		if (active) {
			if (ctx.hasUI) ctx.ui.notify("/continue already queued or running.", "warning");
			return;
		}
		active = true;
		pi.events.emit(CONTINUE_EVENT, { active: true });
		try {
			if (!ctx.isIdle()) {
				if (ctx.hasUI) ctx.ui.notify("/continue queued. Waiting for the current work to finish.", "info");
				await ctx.waitForIdle();
			}
			if (!hasWork(ctx.sessionManager.getBranch())) {
				if (ctx.hasUI) ctx.ui.notify("Nothing to hand over yet.", "warning");
				return;
			}
			const args = parseNextArgs(rawArgs);
			// A handover written moments ago (the run then stopped before the switch) is not written again.
			// Steering or -r asks for a new one.
			const recent = args.rewrite || args.steer ? null : findRecentHandover(ctx.sessionManager.getBranch(), Date.now());
			if (recent) {
				const at = new Date(recent.reply.at).toISOString().slice(11, 16);
				const later = recent.laterPrompts > 0 ? `; ${recent.laterPrompts} later message(s) are not in it` : "";
				if (ctx.hasUI) ctx.ui.notify(`/continue: reusing the handover written at ${at}Z${later}. /continue -r writes a new one.`, "info");
				await finishLean(ctx, args, recent.reply);
				return;
			}
			await runLeanHandover(ctx, args);
		} finally {
			active = false;
			pi.events.emit(CONTINUE_EVENT, { active: false });
		}
	};

	const description = "Handover + fresh session. Notes the handover on the focused mission; /land captures knowledge instead. -r/--rewrite ignores a handover written in the last 15 min; -e opens it in the editor. Queues when busy. /continue [-e] [-r] [steering]";
	pi.registerCommand("continue", { description, handler });
	pi.registerCommand("handover", { description: "Alias of /continue", handler });
}

import test from "node:test";
import assert from "node:assert/strict";

import {
	buildNextPrompt,
	composeHandover,
	extractHandover,
	parseCarry,
	epicFocus,
	parseMissionMeta,
	parseNextArgs,
	registerNext,
	findRecentHandover,
	CONTINUE_EVENT,
} from "../modules/missions/extensions/mission-stack/next.ts";
import { parseResumeIntent } from "../modules/missions/extensions/mission-stack/mission-resume.ts";

// Writes go to the mx CLI; pin its name so exec assertions are stable.
process.env.MX_BIN = "mx";

test("parseNextArgs reads leading edit/rewrite flags and keeps steering", () => {
	assert.deepEqual(parseNextArgs(""), { edit: false, rewrite: false, steer: "" });
	assert.deepEqual(parseNextArgs("-e only auth"), { edit: true, rewrite: false, steer: "only auth" });
	assert.deepEqual(parseNextArgs("-e -r both"), { edit: true, rewrite: true, steer: "both" });
	assert.deepEqual(parseNextArgs("--rewrite"), { edit: false, rewrite: true, steer: "" });
	assert.deepEqual(parseNextArgs("keep -e literal"), { edit: false, rewrite: false, steer: "keep -e literal" });
	// -f is gone: /land is the capture path, so it is steering text now.
	assert.deepEqual(parseNextArgs("-f only auth"), { edit: false, rewrite: false, steer: "-f only auth" });
});

test("prompt forbids tools and carries steering", () => {
	const p = buildNextPrompt("focus on retry logic");
	assert.match(p, /^\/continue:/);
	assert.match(p, /Do not call tools/);
	assert.match(p, /<handover>/);
	assert.match(p, /focus on retry logic/);
	assert.doesNotMatch(buildNextPrompt(""), /Steering/);
});

test("extractHandover tolerates missing tags", () => {
	assert.equal(extractHandover("x <handover>\n## Goal\nA\n</handover> y"), "## Goal\nA");
	assert.equal(extractHandover("<handover>## Goal\nB"), "## Goal\nB");
	assert.equal(extractHandover("## Goal\nC"), "## Goal\nC");
});

test("focused handover opens with a resume intent focus-land understands", () => {
	const h = composeHandover({ body: "## Goal\nX", focus: { id: "mission-abc", title: "T" }, cwd: "/w", repoFacts: "- branch: b" });
	assert.equal(parseResumeIntent(h), "mission-abc");
	assert.match(h, /## Repo \(at handover\)\n- branch: b/);
	const u = composeHandover({ body: "## Goal\nX", focus: null, cwd: "/w", repoFacts: "" });
	assert.equal(parseResumeIntent(u), null);
	assert.doesNotMatch(u, /## Repo/);
});

type ShowResult = Record<string, unknown> | null | "throw";

function harness(opts: { focus?: { id: string } | null; reply: string; aborted?: boolean; edit?: boolean; ops?: boolean; show?: ShowResult; busy?: boolean; beforeNewSession?: () => Promise<void>; prior?: any[]; afterReply?: any[] }) {
	const hooks = new Map<string, Array<(e: any) => unknown>>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const entries: any[] = [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "earlier work" }] } }];
	if (opts.focus) entries.push({ type: "custom", customType: "land-focus", data: opts.focus });
	if (opts.ops !== undefined) entries.push({ type: "custom", customType: "ops-mode", data: { enabled: opts.ops } });
	entries.push(...(opts.prior ?? []));
	const sent: string[] = [];
	const notifications: string[] = [];
	const events: Array<{ topic: string; data: unknown }> = [];
	const idle = Promise.withResolvers<void>();
	let busy = opts.busy ?? false;
	const seeded: Array<{ customType: string; data: unknown }> = [];
	const execs: string[][] = [];
	const shown: string[] = [];
	const store = () => ({
		showIssue: (id: string) => {
			shown.push(id);
			const show = opts.show ?? null;
			if (show === "throw") throw new Error("boom");
			return show;
		},
	});
	const out: { newSession?: any; firstPrompt?: string; editor?: string; seededBeforeSession?: string[] } = {};
	const emit = (name: string, e: any) => (hooks.get(name) ?? []).forEach((h) => h(e));
	const pi: any = {
		on: (n: string, h: any) => hooks.set(n, [...(hooks.get(n) ?? []), h]),
		registerCommand: (n: string, c: any) => commands.set(n, c.handler),
		getThinkingLevel: () => "xhigh",
		exec: async (cmd: string, args: string[]) => {
			execs.push([cmd, ...args]);
			if (cmd === "git") {
				const sub = args[2];
				if (sub === "rev-parse") return { code: 0, stdout: "feature/x\n", stderr: "", killed: false };
				if (sub === "log") return { code: 0, stdout: "abc123 msg\n", stderr: "", killed: false };
				return { code: 0, stdout: " M a.ts\n", stderr: "", killed: false };
			}
			return { code: 0, stdout: "", stderr: "", killed: false };
		},
		sendUserMessage: (text: string) => {
			sent.push(text);
			setTimeout(() => {
				emit("agent_start", {});
				entries.push({ type: "message", message: { role: "user", content: text } });
				entries.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: opts.reply }], stopReason: "stop" } });
				entries.push(...(opts.afterReply ?? []));
				emit("agent_settled", { aborted: !!opts.aborted });
			}, 1);
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		events: { emit: (topic: string, data: unknown) => events.push({ topic, data }), on: () => () => {} },
	};
	registerNext(pi, { store: store as any });
	const ctx: any = {
		hasUI: true,
		cwd: "/work",
		model: { provider: "my-gateway", id: "claude-opus-5-5" },
		ui: { notify: (text: string) => notifications.push(text) },
		isIdle: () => !busy,
		waitForIdle: async () => { if (busy) await idle.promise; },
		sessionManager: { getBranch: () => entries, getEntries: () => entries, getSessionFile: () => "/s/old.jsonl" },
		newSession: async (o: any) => {
			await opts.beforeNewSession?.();
			out.newSession = o;
			await o.setup?.({ appendCustomEntry: (customType: string, data: unknown) => seeded.push({ customType, data }) });
			out.seededBeforeSession = seeded.map((e) => e.customType);
			await o.withSession({
				ui: { setEditorText: (t: string) => (out.editor = t), notify: () => {} },
				sendUserMessage: async (t: string) => {
					out.firstPrompt = t;
				},
			});
			return { cancelled: false };
		},
	};
	const shows = () => shown;
	const notes = () => execs.filter((e) => e[0] === "mx" && e[1] === "note");
	const finishWork = () => {
		busy = false;
		emit("agent_settled", { aborted: false });
		idle.resolve();
	};
	return { run: (args = "", command = "continue") => commands.get(command)!(args, ctx), sent, commands, execs, out, seeded, hooks, shows, notes, notifications, emit, finishWork, idle, events, entries };
}

test("registers /continue and /handover only", () => {
	const h = harness({ reply: "" });
	assert.deepEqual([...h.commands.keys()].sort(), ["continue", "handover"]);
	assert.equal(h.commands.get("continue"), h.commands.get("handover"));
});

test("busy /continue acknowledges one queued request and preserves its edit flag and steering", async () => {
	const h = harness({ busy: true, reply: "<handover>## Goal\nFinish the work</handover>" });
	const run = h.run("-e keep the retry findings");
	try {
		assert.match(h.notifications.join("\n"), /\/continue queued/i);
		assert.equal(h.sent.length, 0, "the current work is not interrupted");
		await h.run("different steering", "handover");
		assert.match(h.notifications.at(-1)!, /already queued or running/i);
		h.emit("agent_end", {});
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(h.sent.length, 0, "agent_end is not the idle boundary");
	} finally {
		h.finishWork();
		await run;
	}
	assert.equal(h.sent.length, 1);
	assert.match(h.sent[0], /keep the retry findings/);
	assert.doesNotMatch(h.sent[0], /different steering/);
	assert.match(h.out.editor!, /Finish the work/);
	assert.equal(h.out.firstPrompt, undefined);
});

test("/continue keeps the request reserved until session replacement finishes", async () => {
	const switching = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const h = harness({
		reply: "<handover>## Goal\nG</handover>",
		beforeNewSession: async () => { switching.resolve(); await release.promise; },
	});
	const run = h.run();
	await switching.promise;
	const duplicate = h.run();
	try {
		assert.match(h.notifications.at(-1)!, /already queued or running/i);
		assert.equal(h.sent.length, 1);
	} finally {
		release.resolve();
		await Promise.all([run, duplicate]);
	}
});

test("/continue releases a queued request if waiting for idle fails", async () => {
	const h = harness({ busy: true, reply: "<handover>## Goal\nG</handover>" });
	const run = h.run();
	h.idle.reject(new Error("session closed"));
	await assert.rejects(run, /session closed/);
	h.finishWork();
	await h.run();
	assert.equal(h.sent.length, 1);
	assert.match(h.out.firstPrompt!, /## Goal\nG/);
});

const epic = (id: string, extra: object = {}) => ({ id, issue_type: "epic", title: "Epic T", ...extra });

test("parseMissionMeta reads only the first line and strips it", () => {
	assert.deepEqual(parseMissionMeta("<mission>mission-abc</mission>\n## Goal\nX"), { body: "## Goal\nX", mission: "mission-abc" });
	assert.deepEqual(parseMissionMeta("\n  <mission> mission-abc </mission>\n## Goal"), { body: "## Goal", mission: "mission-abc" });
	assert.deepEqual(parseMissionMeta("<mission>none</mission>\n## Goal"), { body: "## Goal", mission: null });
	// Old handovers and incidental mentions pass through untouched.
	assert.deepEqual(parseMissionMeta("## Goal\nsee mission-xyz"), { body: "## Goal\nsee mission-xyz", mission: null });
	assert.deepEqual(parseMissionMeta("## Goal\n<mission>mission-xyz</mission>"), { body: "## Goal\n<mission>mission-xyz</mission>", mission: null });
	// Malformed / ambiguous / duplicate.
	assert.equal(parseMissionMeta("<mission>mission-a mission-b</mission>\nX").mission, null);
	assert.equal(parseMissionMeta("<mission>mission-a.1</mission>\nX").mission, null);
	assert.equal(parseMissionMeta("<mission>Mission-ABC</mission>\nX").mission, null);
	assert.equal(parseMissionMeta("<mission>mission-a\nX").mission, null);
	assert.equal(parseMissionMeta("<mission>mission-a</mission> extra\nX").mission, null);
	const dup = parseMissionMeta("<mission>mission-a</mission>\n<mission>mission-b</mission>\nX");
	assert.equal(dup.mission, null);
	assert.doesNotMatch(dup.body, /mission-a/);
});

test("epicFocus validates exact id and epic type", () => {
	assert.deepEqual(epicFocus(epic("mission-a"), "mission-a"), { id: "mission-a", title: "Epic T" });
	assert.deepEqual(epicFocus({ id: "mission-a", issue_type: "epic" }, "mission-a"), { id: "mission-a" });
	assert.equal(epicFocus(epic("mission-b"), "mission-a"), null);
	assert.equal(epicFocus(epic("mission-a", { issue_type: "task" }), "mission-a"), null);
	assert.equal(epicFocus(null, "mission-a"), null);
});

test("unfocused /continue focuses the declared, validated mission", async () => {
	const h = harness({ reply: "<handover>\n<mission>mission-abc</mission>\n## Goal\nG\n</handover>", show: epic("mission-abc") });
	await h.run();
	assert.deepEqual(h.shows(), ["mission-abc"]);
	const first = h.out.firstPrompt!;
	assert.equal(parseResumeIntent(first), "mission-abc");
	assert.match(first, /Resume mission-abc \(Epic T\)/);
	assert.doesNotMatch(first, /<mission>/);
	assert.equal(h.notes().length, 1);
	assert.equal(h.notes()[0][2], "mission-abc");
	assert.deepEqual(h.seeded[0], { customType: "land-focus", data: { id: "mission-abc", title: "Epic T" } });
});

test("existing focus beats declared mission and skips lookup", async () => {
	const h = harness({ focus: { id: "mission-old" }, reply: "<handover><mission>mission-new</mission>\n## Goal\nG</handover>", show: epic("mission-new") });
	await h.run();
	assert.equal(h.shows().length, 0);
	assert.equal(parseResumeIntent(h.out.firstPrompt!), "mission-old");
	assert.equal(h.notes()[0][2], "mission-old");
	assert.deepEqual(h.seeded[0], { customType: "land-focus", data: { id: "mission-old" } });
});

test("absent, none or incidental mission ids leave the session unfocused", async () => {
	for (const reply of [
		"<handover>## Goal\nG</handover>",
		"<handover><mission>none</mission>\n## Goal\nG</handover>",
		"<handover>## Goal\nfixed like mission-xyz did</handover>",
	]) {
		const h = harness({ reply, show: epic("mission-xyz") });
		await h.run();
		assert.equal(h.shows().length, 0, reply);
		assert.equal(h.notes().length, 0, reply);
		assert.match(h.out.firstPrompt!, /^Continue in/);
		assert.ok(!h.seeded.some((e) => e.customType === "land-focus"));
	}
});

test("failed or non-epic validation continues unfocused", async () => {
	const results: ShowResult[] = [null, "throw", epic("mission-abc", { issue_type: "task" }), epic("mission-other")];
	for (const show of results) {
		const h = harness({ reply: "<handover><mission>mission-abc</mission>\n## Goal\nG</handover>", show });
		await h.run();
		assert.equal(h.shows().length, 1);
		assert.equal(h.notes().length, 0);
		assert.match(h.out.firstPrompt!, /^Continue in/);
		assert.doesNotMatch(h.out.firstPrompt!, /<mission>/);
		assert.ok(!h.seeded.some((e) => e.customType === "land-focus"));
	}
});

test("/continue -e seeds focus before the editor is filled", async () => {
	const h = harness({ reply: "<handover><mission>mission-abc</mission>\n## Goal\nG</handover>", show: epic("mission-abc") });
	await h.run("-e");
	assert.ok(h.out.seededBeforeSession!.includes("land-focus"));
	assert.equal(parseResumeIntent(h.out.editor!), "mission-abc");
	assert.equal(h.out.firstPrompt, undefined);
});

test("/continue writes handover, notes the focused mission and auto-sends it", async () => {
	const h = harness({ focus: { id: "mission-abc" }, reply: "<handover>\n## Goal\nShip it\n## Next\n1. Run tests\n</handover>" });
	assert.ok(h.commands.has("handover"));
	await h.run("tests first");
	assert.equal(h.sent.length, 1);
	assert.match(h.sent[0], /tests first/);
	assert.equal(h.out.newSession.parentSession, "/s/old.jsonl");
	const first = h.out.firstPrompt!;
	assert.equal(parseResumeIntent(first), "mission-abc");
	assert.match(first, /## Goal\nShip it/);
	assert.match(first, /- branch: feature\/x/);
	assert.match(first, /M a\.ts/);
	const note = h.execs.find((e) => e[0] === "mx");
	assert.ok(note, "mx note was called");
	assert.deepEqual(note!.slice(1, 3), ["note", "mission-abc"]);
	assert.match(note![3], /^## Context Snapshot .* \(\/continue\)/);
});

test("/continue -e loads the editor instead of sending", async () => {
	const h = harness({ reply: "<handover>## Goal\nY</handover>" });
	await h.run("-e");
	assert.equal(h.out.firstPrompt, undefined);
	assert.match(h.out.editor!, /^Continue in \/work/);
	assert.equal(h.execs.find((e) => e[0] === "mx"), undefined, "no mission, no mx note");
});

test("aborted handover turn does not switch sessions", async () => {
	const h = harness({ reply: "partial", aborted: true });
	await h.run();
	assert.equal(h.out.newSession, undefined);
});

test("/continue carries model, thinking level and Ops Mode", async () => {
	const h = harness({ reply: "<handover>## Goal\nZ</handover>", ops: true });
	await h.run();
	assert.deepEqual(h.seeded, [
		{ customType: "next-carry", data: { model: { provider: "my-gateway", id: "claude-opus-5-5" }, thinkingLevel: "xhigh" } },
		{ customType: "ops-mode", data: { enabled: true } },
	]);
});

test("/continue does not seed Ops Mode when it was turned off", async () => {
	const h = harness({ reply: "<handover>## Goal\nZ</handover>", ops: false });
	await h.run();
	assert.deepEqual(h.seeded.map((e) => e.customType), ["next-carry"]);
});

test("/continue never sends a land prompt, even with a focused mission", async () => {
	const h = harness({ focus: { id: "mission-abc" }, reply: "<handover>## Goal\nX</handover>" });
	await h.run();
	assert.equal(h.sent.length, 1);
	assert.match(h.sent[0], /^\/continue:/);
	assert.doesNotMatch(h.sent[0], /LAND THE PLANE/);
});

function restoreHarness(opts: { carry?: unknown; reason?: string; current?: { provider: string; id: string }; auth?: boolean }) {
	const hooks = new Map<string, Array<(e: any, ctx: any) => unknown>>();
	const calls: { model?: any; thinking?: string; notes: string[] } = { notes: [] };
	const pi: any = {
		on: (n: string, h: any) => hooks.set(n, [...(hooks.get(n) ?? []), h]),
		registerCommand: () => {},
		setModel: async (m: any) => {
			calls.model = m;
			return opts.auth !== false;
		},
		setThinkingLevel: (l: string) => (calls.thinking = l),
	};
	registerNext(pi);
	const entries = opts.carry === undefined ? [] : [{ type: "custom", customType: "next-carry", data: opts.carry }];
	const ctx: any = {
		hasUI: true,
		model: opts.current ?? { provider: "github-copilot", id: "gpt-6.1-sol" },
		modelRegistry: { find: (provider: string, id: string) => (provider === "gone" ? undefined : { provider, id }) },
		sessionManager: { getEntries: () => entries },
		ui: { notify: (m: string) => calls.notes.push(m) },
	};
	const fire = () => Promise.all((hooks.get("session_start") ?? []).map((h) => h({ type: "session_start", reason: opts.reason ?? "new" }, ctx)));
	return { fire, calls };
}

const carry = { model: { provider: "my-gateway", id: "claude-opus-5-5" }, thinkingLevel: "xhigh" };

test("new session restores the carried model and thinking level", async () => {
	const r = restoreHarness({ carry });
	await r.fire();
	assert.deepEqual(r.calls.model, carry.model);
	assert.equal(r.calls.thinking, "xhigh");
});

test("restore skips setModel when the model already matches", async () => {
	const r = restoreHarness({ carry, current: carry.model });
	await r.fire();
	assert.equal(r.calls.model, undefined);
	assert.equal(r.calls.thinking, "xhigh");
});

test("restore ignores resumed sessions and sessions without a carry entry", async () => {
	const resumed = restoreHarness({ carry, reason: "resume" });
	await resumed.fire();
	assert.equal(resumed.calls.model, undefined);
	assert.equal(resumed.calls.thinking, undefined);
	const plain = restoreHarness({});
	await plain.fire();
	assert.equal(plain.calls.model, undefined);
});

test("restore warns when the carried model is unavailable", async () => {
	const missing = restoreHarness({ carry: { ...carry, model: { provider: "gone", id: "x" } } });
	await missing.fire();
	assert.equal(missing.calls.model, undefined);
	assert.match(missing.calls.notes.join("\n"), /gone\/x/);
	const noAuth = restoreHarness({ carry, auth: false });
	await noAuth.fire();
	assert.match(noAuth.calls.notes.join("\n"), /claude-opus-5-5/);
});

test("parseCarry accepts every pi thinking level and rejects junk", () => {
	assert.deepEqual(parseCarry({ model: null, thinkingLevel: "max" }), { model: null, thinkingLevel: "max" });
	assert.equal(parseCarry({ model: null, thinkingLevel: "turbo" }), null);
	assert.equal(parseCarry({ model: { provider: 1, id: "x" }, thinkingLevel: "low" }), null);
	assert.equal(parseCarry("nope"), null);
});

const LEAN = "/continue: write the handover a fresh session will start from.";
const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const userMsg = (text: string, ts = at(0)) => ({ type: "message", timestamp: ts, message: { role: "user", content: [{ type: "text", text }] } });
const asst = (text: string, ts = at(0), stopReason = "stop", id?: string) => ({ type: "message", id, timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }], stopReason } });

test("findRecentHandover returns a fresh lean handover and counts later prompts", () => {
	const now = Date.now();
	const entries = [userMsg(LEAN, at(120_000)), asst("<handover>\n## Goal\nA\n</handover>", at(100_000)), userMsg("From: ops-expert2\nqueue handoff", at(60_000)), asst("", at(50_000), "aborted")];
	const r = findRecentHandover(entries, now);
	assert.ok(r);
	assert.match(r!.reply.text, /## Goal\nA/);
	assert.equal(r!.laterPrompts, 1);
});

test("findRecentHandover ignores stale, aborted and tag-less replies", () => {
	const now = Date.now();
	assert.equal(findRecentHandover([userMsg(LEAN, at(20 * 60_000)), asst("<handover>x</handover>", at(16 * 60_000))], now), null);
	assert.equal(findRecentHandover([userMsg(LEAN), asst("<handover>x", at(0), "aborted")], now), null);
	assert.equal(findRecentHandover([userMsg(LEAN), asst("no tags here")], now), null);
	assert.equal(findRecentHandover([userMsg("ordinary prompt"), asst("<handover>x</handover>")], now), null);
	// Entries without timestamps never count as fresh.
	assert.equal(findRecentHandover([{ type: "message", message: { role: "user", content: LEAN } }, { type: "message", message: { role: "assistant", content: "<handover>x</handover>", stopReason: "stop" } }], now), null);
});

test("findRecentHandover ignores land replies", () => {
	const land = "Saved.\n```\nResume mission-abc (T) in /w.\n```";
	assert.equal(findRecentHandover([userMsg("LAND THE PLANE for mission-abc: update the mission."), asst(land)], Date.now()), null);
});

test("/continue reuses a fresh handover without another turn", async () => {
	const h = harness({
		focus: { id: "mission-abc" },
		reply: "unused",
		prior: [userMsg(LEAN, at(90_000)), asst("<handover>\n## Goal\nReuse me\n</handover>", at(60_000), "stop", "e1")],
	});
	await h.run();
	assert.equal(h.sent.length, 0, "no new handover turn");
	assert.match(h.out.firstPrompt!, /## Goal\nReuse me/);
	assert.equal(parseResumeIntent(h.out.firstPrompt!), "mission-abc");
	assert.match(h.notifications.join("\n"), /reusing the handover written at/);
	assert.equal(h.notes().length, 1);
});

test("a reused handover is not noted on the mission twice", async () => {
	const h = harness({
		focus: { id: "mission-abc" },
		reply: "unused",
		prior: [userMsg(LEAN, at(90_000)), asst("<handover>\n## Goal\nR\n</handover>", at(60_000), "stop", "e1"), { type: "custom", customType: "continue-noted", data: { key: "e1" } }],
	});
	await h.run();
	assert.equal(h.sent.length, 0);
	assert.equal(h.notes().length, 0);
	assert.ok(h.out.firstPrompt);
});

test("-r and steering write a new handover even when a fresh one exists", async () => {
	for (const args of ["-r", "only the batch"]) {
		const h = harness({ reply: "<handover>## Goal\nNew</handover>", prior: [userMsg(LEAN, at(90_000)), asst("<handover>## Goal\nOld</handover>", at(60_000))] });
		await h.run(args);
		assert.equal(h.sent.length, 1, args);
		assert.match(h.out.firstPrompt!, /## Goal\nNew/, args);
	}
});

test("a teammate turn after the handover reply is not read as the handover", async () => {
	const h = harness({ reply: "<handover>## Goal\nMine</handover>", afterReply: [userMsg("From: ops-expert2\nqueue handoff"), asst("", at(0), "aborted")] });
	await h.run();
	assert.match(h.out.firstPrompt!, /## Goal\nMine/);
});

test("/continue flags itself on the event bus and cancels compaction except overflow", async () => {
	let during: unknown;
	const h = harness({
		reply: "<handover>## Goal\nZ</handover>",
		beforeNewSession: async () => {
			const before = h.hooks.get("session_before_compact")![0];
			during = [before({ reason: "manual" }), before({ reason: "threshold" }), before({ reason: "overflow" })];
		},
	});
	await h.run();
	assert.deepEqual(during, [{ cancel: true }, { cancel: true }, undefined]);
	assert.equal(h.hooks.get("session_before_compact")![0]({ reason: "manual" }), undefined, "idle again after /continue");
	assert.deepEqual(h.events, [{ topic: CONTINUE_EVENT, data: { active: true } }, { topic: CONTINUE_EVENT, data: { active: false } }]);
});

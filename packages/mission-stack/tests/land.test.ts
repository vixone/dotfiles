import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const { registerFocusLand, loadLandPromptTemplate, renderLandPrompt, renderLandState, carriedPending } = await import(join(repo, "modules/missions/extensions/mission-stack/focus-land.ts"));
const { CORRECTION_ENTRY_TYPE, CORRECTION_CONSUMED_TYPE, collectCorrectionCandidates, markCorrectionsConsumed, registerCorrectionDetector } = await import(join(repo, "modules/missions/extensions/mission-stack/correction-detector.ts"));
const protocol = join(repo, "modules/missions/protocol/Missions.md");
const loaded = loadLandPromptTemplate(protocol);

test("land captures first, then saves one snapshot, and stays in the session", () => {
	assert.equal(loaded.source, "missions-md");
	const prompt = renderLandPrompt(loaded.template, "mission-abc");
	assert.ok(prompt.indexOf("memory_check_duplicate") < prompt.indexOf("mx remember"));
	assert.ok(prompt.indexOf("mx remember") < prompt.indexOf("mx note mission-abc"), "captures before the snapshot");
	assert.match(prompt, /at most 2/);
	assert.match(prompt, /### Recorded/);
	assert.match(prompt, /### Pending capture/);
	assert.match(prompt, /secret/);
	assert.match(prompt, /do not run mx show or mx children/);
	assert.doesNotMatch(prompt, /mx comment|receipt|RESUME PROMPT|Resume mission-abc/);
});

test("fallback land also saves the handover before learning", () => {
	const fallback = loadLandPromptTemplate("/does/not/exist/Missions.md");
	assert.equal(fallback.source, "fallback");
	assert.ok(fallback.template.indexOf("mx remember") < fallback.template.indexOf("mx note"));
	assert.match(fallback.template, /memory_check_duplicate/);
});

function landing(initialNotes = "## Context Snapshot - prior\n### Current state and next action\n- Previous state", hasUI = false) {
	const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const entries: unknown[] = [{
		type: "custom", customType: CORRECTION_ENTRY_TYPE,
		data: { ts: 101, userText: "No, use bugfix/ instead of fix/", matchedPattern: "No" },
	}];
	let notes = initialNotes;
	const before = notes;
	const indexed: string[] = [];
	const messages: string[] = [];
	const warnings: string[] = [];
	const pi = {
		on(name: string, handler: (event: any, ctx: any) => unknown) {
			hooks.set(name, [...(hooks.get(name) ?? []), handler]);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
			commands.set(name, command.handler);
		},
		appendEntry(type: string, data: unknown) { entries.push({ type: "custom", customType: type, data }); },
		sendUserMessage(message: string) { messages.push(message); },
		async exec(command: string, args: string[]) {
			if (command === "/bin/sh" && args.some(arg => arg.includes("--add-children"))) {
				const id = args[args.length - 1];
				indexed.push(id);
				return { code: 0, stdout: "indexed", stderr: "", killed: false };
			}
			if (command === "/bin/sh") return { code: 0, stdout: "", stderr: "", killed: false };
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")}`);
		},
	};
	const ctx = {
		hasUI,
		ui: {
			notify(message: string, level: string) { if (level === "warning") warnings.push(message); },
			setStatus() {},
			theme: { fg: (_color: string, text: string) => text },
		},
		isIdle: () => true,
		async waitForIdle() {},
		sessionManager: { getEntries: () => entries },
	};
	// Mission reads come from mx.db in-process; this stub stands in for it.
	const store = () => ({
		showIssue: (id: string) => ({ id, title: "Example", issue_type: "epic", status: "in_progress", notes, labels: [], comments: [] }),
		children: () => [{ id: "mission-abc.3", title: "[action] Next action", status: "open" }],
		epicRows: () => [],
		searchEpics: () => [],
		listEpics: () => [],
		listUnclosed: () => [],
	});
	registerFocusLand(pi, undefined, { store });
	registerCorrectionDetector(pi);
	async function emit(name: string, event: unknown) {
		const results = [];
		for (const handler of hooks.get(name) ?? []) results.push(await handler(event, ctx));
		return results;
	}
	return {
		async start(target = "mission-abc") {
			await commands.get("land")!(target, ctx);
		},
		ctx,
		commands,
		emit,
		setSnapshot(snapshot = "## Context Snapshot - new\n### Current state and next action\n- Next action: mission-abc.3\n### Pending capture\n- Check correction") { notes = `${before}\n\n${snapshot}`; },
		getNotes() { return notes; },
		entries,
		indexed,
		messages,
		warnings,
	};
}

test("/land sends one prompt with the mission state preloaded", async () => {
	const run = landing("## Context Snapshot - prior\n### Pending capture\n- Carry me");
	await run.start();
	assert.equal(run.messages.length, 1);
	assert.match(run.messages[0], /^LAND THE PLANE for mission-abc/);
	assert.match(run.messages[0], /## Mission state \(preloaded/);
	assert.match(run.messages[0], /- Carry me/);
	assert.match(run.messages[0], /- mission-abc\.3 \[open\] \[action\] Next action/);
});

test("/land refuses a second request while one is in flight", async () => {
	const run = landing(undefined, true);
	await run.start();
	await run.start();
	assert.equal(run.messages.length, 1);
	assert.match(run.warnings.join("\n"), /already queued or running/);
});

test("/land waits for idle before preparing", async () => {
	const run = landing();
	let idle = false;
	run.ctx.isIdle = () => idle;
	run.ctx.waitForIdle = async () => { idle = true; };
	await run.start();
	assert.equal(idle, true);
	assert.equal(run.messages.length, 1);
});

test("renderLandState carries the last landing's Pending capture past a /continue snapshot", () => {
	const notes = [
		"## Context Snapshot 2026-11-12 09:00Z (/land)\n### Recorded\n- mission-abc.4\n### Pending capture\n- Lesson about X\n",
		"## Context Snapshot 2026-11-12 10:00 (/continue)\n\nResume mission-abc ...\n## Next\n1. Y",
	].join("\n");
	const state = renderLandState({ notes }, []);
	assert.match(state, /### Pending capture carried from `## Context Snapshot 2026-11-12 09:00Z \(\/land\)`\n- Lesson about X/);
	assert.equal(carriedPending(notes.replace("- Lesson about X", "- None")), null);
	assert.equal(carriedPending("## Context Snapshot a\n### Pending capture\n- Z"), null, "latest has its own");
});

test("renderLandState lists open children first, then the newest closed ones", () => {
	const children = [
		...Array.from({ length: 45 }, (_, i) => ({ id: `mission-abc.${i + 1}`, title: `[finding] F${i + 1}`, status: "closed" })),
		{ id: "mission-abc.46", title: "[action] Open one", status: "open" },
	];
	const state = renderLandState({ notes: "old\n## Context Snapshot - x\nbody" }, children);
	assert.match(state, /### Latest snapshot\n## Context Snapshot - x\nbody/);
	assert.doesNotMatch(state, /^old$/m);
	assert.match(state, /Children \(46: 1 open, 5 older closed not listed\)/);
	const listed = state.split("\n").filter((l: string) => l.startsWith("- mission-abc."));
	assert.equal(listed[0], "- mission-abc.46 [open] [action] Open one");
	assert.equal(listed[1], "- mission-abc.45 [closed] [finding] F45");
	assert.equal(listed.length, 41);
	assert.match(renderLandState(null, []), /### Latest snapshot\n- None[\s\S]*- None/);
});

const embeddedSkill = '<skill name="poteto-mode" location="/skills/poteto-mode/SKILL.md">\nBuild the tool, not by hand.\n</skill>';

async function sendUser(run: ReturnType<typeof landing>, text: string) {
	const message = { role: "user", content: [{ type: "text", text }] };
	await run.emit("message_end", { message });
	run.entries.push({ type: "message", message });
}

test("skill instructions do not become correction candidates in land", async () => {
	const run = landing();
	run.entries.length = 0;
	await sendUser(run, embeddedSkill);
	await run.start();
	assert.deepEqual(collectCorrectionCandidates({ sessionManager: { getEntries: () => run.entries } }), []);
	assert.doesNotMatch(run.messages[0], /Correction candidates|poteto-mode/);
});

test("the auto-injected /continue resume prompt is not a correction candidate", async () => {
	const run = landing();
	run.entries.length = 0;
	// Shape /continue auto-sends into the fresh session: a resume intent whose
	// embedded snapshot body contains correction-like phrasing ("not", "don't").
	await sendUser(run, "Resume mission-1tc (Migrate ingress-nginx -> Envoy Gateway) in /repo. Load envoy-ingress.\n\nNext action: do not rerun cutover; use bugfix/ not fix/.");
	await sendUser(run, "No, use bugfix/ instead of fix/");
	const candidates = collectCorrectionCandidates({ sessionManager: { getEntries: () => run.entries } });
	// Only the genuine correction survives; the resume prompt is skipped.
	assert.deepEqual(candidates.map((c: { userText: string }) => c.userText), ["No, use bugfix/ instead of fix/"]);
});

for (const [name, message, expected] of [
	["after", `${embeddedSkill}\n\nNo, use bugfix/ instead of fix/`, "No, use bugfix/ instead of fix/"],
	["before", `No, use bugfix/ instead of fix/\n\n${embeddedSkill}`, "No, use bugfix/ instead of fix/"],
	["between", `${embeddedSkill}\n\nNo, use bugfix/ instead of fix/\n\n${embeddedSkill}`, "No, use bugfix/ instead of fix/"],
	["negative skill text", `${embeddedSkill.replace("Build the tool, not by hand.", "No problem.")}\n\nNo, use bugfix/ instead of fix/`, "No, use bugfix/ instead of fix/"],
	["ordinary", "No, use bugfix/ instead of fix/", "No, use bugfix/ instead of fix/"],
]) {
	test(`real correction survives ${name} skill extraction`, async () => {
		const run = landing();
		run.entries.length = 0;
		await sendUser(run, message);
		const candidates = collectCorrectionCandidates({ sessionManager: { getEntries: () => run.entries } });
		assert.deepEqual(candidates.map((c: { userText: string }) => c.userText), [expected]);
		await run.start();
		assert.match(run.messages[0], /Correction candidates/);
		assert.match(run.messages[0], /No, use bugfix\/ instead of fix\//);
		assert.doesNotMatch(run.messages[0], /poteto-mode|Build the tool|No problem/);
	});
}

test("legacy truncated skills recover the full message before filtering", async () => {
	const run = landing();
	run.entries.length = 0;
	const longSkill = embeddedSkill.replace("Build the tool", "x".repeat(1800) + "Build the tool");
	for (const [i, message] of [longSkill, `${longSkill}\n\nNo, use bugfix/ instead of fix/`].entries()) {
		run.entries.push({ type: "custom", customType: CORRECTION_ENTRY_TYPE,
			data: { ts: i + 1, userText: message.slice(0, 1500) + "…", matchedPattern: String.raw`,\s*not\s+\S+` } });
		run.entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text: message }] } });
	}
	const context = { sessionManager: { getEntries: () => run.entries } };
	const candidates = collectCorrectionCandidates(context);
	assert.deepEqual(candidates.map((c: { ts: number; userText: string }) => [c.ts, c.userText]), [[2, "No, use bugfix/ instead of fix/"]]);
	await run.start();
	assert.doesNotMatch(run.messages[0], /poteto-mode/);
	await run.emit("agent_before_settle", { outcome: "aborted", continue: false });
	await run.emit("agent_settled", { aborted: true });
	assert.deepEqual(collectCorrectionCandidates(context), candidates);
});

test("legacy candidate is retained when its truncated source cannot be recovered", () => {
	const run = landing();
	run.entries.length = 0;
	const candidate = { ts: 1, userText: embeddedSkill.slice(0, 85) + "…", matchedPattern: "No" };
	run.entries.push({ type: "custom", customType: CORRECTION_ENTRY_TYPE, data: candidate });
	run.entries.push({ type: "message", message: { role: "user", content: "Unrelated message" } });
	assert.deepEqual(collectCorrectionCandidates({ sessionManager: { getEntries: () => run.entries } }), [candidate]);
});

test("an aborted landing retains its correction and does not index another mission", async () => {
	const run = landing();
	await run.start();
	assert.match(run.messages[0], /correction candidates/i);
	await run.emit("agent_end", { messages: [] });
	await run.emit("agent_before_settle", { outcome: "aborted", continue: false });
	await run.emit("agent_settled", { aborted: true });
	assert.equal(run.entries.filter((e: any) => e.customType === CORRECTION_CONSUMED_TYPE).length, 0);
	assert.deepEqual(run.indexed, []);
});

test("errored landing keeps corrections even if it saved a handover", async () => {
	const run = landing();
	await run.start();
	run.setSnapshot();
	await run.emit("agent_before_settle", { outcome: "error", continue: false });
	await run.emit("agent_settled", { aborted: false });
	assert.equal(run.entries.filter((e: any) => e.customType === CORRECTION_CONSUMED_TYPE).length, 0);
	assert.deepEqual(run.indexed, []);
});

test("completed landing without a saved snapshot leaves corrections pending", async () => {
	const run = landing();
	await run.start();
	await run.emit("agent_end", { messages: [] });
	await run.emit("agent_before_settle", { outcome: "completed", continue: false });
	await run.emit("agent_settled", { aborted: false });
	assert.equal(run.entries.filter((e: any) => e.customType === CORRECTION_CONSUMED_TYPE).length, 0);
});

test("completed landing consumes corrections after snapshot and indexes explicit target", async () => {
	const run = landing();
	await run.start();
	run.setSnapshot();
	await run.emit("agent_end", { messages: [] });
	await run.emit("agent_before_settle", { outcome: "completed", continue: false });
	await run.emit("agent_settled", { aborted: false });
	const consumed = run.entries.filter((e: any) => e.customType === CORRECTION_CONSUMED_TYPE);
	assert.equal(consumed.length, 1);
	assert.equal((consumed[0] as { data: { cutoffTs: number } }).data.cutoffTs, 101);
	assert.deepEqual(run.indexed, ["mission-abc"]);
});

const longSnapshot = "## Context Snapshot - new\n### Current state and next action\n- Next action: mission-abc.3\n" +
	"Working context. ".repeat(200) + "\n### Pending capture\n- Tail-only evidence";

async function finishLanding(run: ReturnType<typeof landing>) {
	await run.emit("agent_before_settle", { outcome: "completed", continue: false });
	await run.emit("agent_settled", { aborted: false });
}

function consumedCount(run: ReturnType<typeof landing>) {
	return run.entries.filter((entry: any) => entry.customType === CORRECTION_CONSUMED_TYPE).length;
}

test("long saved snapshot clears corrections and indexes without a false warning", async () => {
	assert.ok(longSnapshot.indexOf("### Pending capture") > 2200);
	const run = landing(undefined, true);
	await run.start();
	run.setSnapshot(longSnapshot);
	await finishLanding(run);
	assert.equal(consumedCount(run), 1);
	assert.deepEqual(run.indexed, ["mission-abc"]);
	assert.deepEqual(run.warnings, []);
});

test("a snapshot change beyond the preview is detected", async () => {
	const original = "## Context Snapshot - same header\n### Pending capture\n- None\n" + "x".repeat(2500) + "old tail";
	const updated = original.replace("old tail", "new tail");
	assert.equal(original.slice(0, 2200), updated.slice(0, 2200));
	const run = landing(original, true);
	await run.start();
	run.setSnapshot(updated);
	await finishLanding(run);
	assert.equal(consumedCount(run), 1);
	assert.deepEqual(run.indexed, ["mission-abc"]);
	assert.deepEqual(run.warnings, []);
});

for (const [name, initial, saved] of [
	["unchanged long snapshot", longSnapshot, longSnapshot],
	["missing Pending capture in latest snapshot", longSnapshot, "## Context Snapshot - invalid\nNo capture section"],
	["missing snapshot marker", "", "### Pending capture\n- None"],
]) {
	test(`${name} still leaves corrections pending`, async () => {
		const run = landing(initial, true);
		await run.start();
		run.setSnapshot(saved);
		await finishLanding(run);
		assert.equal(consumedCount(run), 0);
		assert.deepEqual(run.indexed, []);
		assert.deepEqual(run.warnings, ["/land saved no new snapshot on mission-abc. Corrections remain pending."]);
	});
}

test("fresh resume keeps long snapshots bounded to the display preview", async () => {
	const run = landing(longSnapshot);
	const results = await run.emit("before_agent_start", {
		messageType: "user", prompt: "Resume mission-abc (Example).", systemPrompt: "Base instructions",
	});
	assert.ok(results[0] && typeof results[0] === "object" && "systemPrompt" in results[0]);
	const prompt = String(results[0].systemPrompt);
	assert.ok(prompt.includes(longSnapshot.slice(0, 2200).trimEnd()));
	assert.match(prompt, /truncated - run `mx show <mission-id>` for full notes/);
	assert.doesNotMatch(prompt, /Tail-only evidence/);
	assert.match(prompt, /Next action: mission-abc\.3/);
});

test("explicit land target replaces a different session focus", async () => {
	const run = landing();
	run.entries.push({ type: "custom", customType: "land-focus", data: { id: "mission-other" } });
	await run.start();
	const results = await run.emit("before_agent_start", { messageType: "user", prompt: run.messages[0], systemPrompt: "Base" });
	assert.ok(results[0] && typeof results[0] === "object" && "systemPrompt" in results[0]);
	assert.match(String(results[0].systemPrompt), /## Active Mission: mission-abc/);
	assert.doesNotMatch(String(results[0].systemPrompt), /## Active Mission: mission-other/);
});

test("correction batches retain unprocessed candidates for a later landing", () => {
	const entries: Array<{ type: string; customType: string; data: unknown }> = Array.from({ length: 7 }, (_, i) => ({
		type: "custom", customType: CORRECTION_ENTRY_TYPE,
		data: { ts: i + 1, userText: `Correction ${i + 1}`, matchedPattern: "No" },
	}));
	const context = { sessionManager: { getEntries: () => entries } };
	const batch = collectCorrectionCandidates(context);
	assert.deepEqual(batch.map((c: { ts: number }) => c.ts), [1, 2, 3, 4, 5, 6]);
	markCorrectionsConsumed({ appendEntry: (type: string, data: unknown) => {
		entries.push({ type: "custom", customType: type, data });
	} }, batch);
	assert.deepEqual(collectCorrectionCandidates(context).map((c: { ts: number }) => c.ts), [7]);
});

test("fresh resume auto-focuses and injects saved state and next action", async () => {
	const run = landing();
	run.setSnapshot();
	const resumed = landing(run.getNotes());
	const results = await resumed.emit("before_agent_start", {
		messageType: "user", prompt: "Resume mission-abc (Example) in /tmp/work. Load the missions skill.", systemPrompt: "Base instructions",
	});
	assert.ok(results[0] && typeof results[0] === "object" && "systemPrompt" in results[0]);
	const systemPrompt = String(results[0].systemPrompt);
	assert.match(systemPrompt, /## Active Mission: mission-abc/);
	assert.match(systemPrompt, /Next action: mission-abc\.3/);
	assert.match(systemPrompt, /mission-abc\.3: Next action/);
});

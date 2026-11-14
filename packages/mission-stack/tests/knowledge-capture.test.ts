import test from "node:test";
import assert from "node:assert/strict";

import {
	proposeDestination,
	planEnvironmentUpdate,
	trackedIndex,
	type ExistingKeys,
} from "../modules/missions/extensions/mission-stack/knowledge-capture.ts";
import { type EnvRecord } from "../modules/missions/extensions/mission-stack/environment-source.ts";

// --- Destination proposal + per-type validation. ---

test("environment fact needs scope + source, not the lesson rubric", () => {
	const ok = proposeDestination({ text: "the proxy wrapper is inline only", scope: "workstation", sources: ["CLAUDE.md"] });
	assert.equal(ok.destination, "environment");
	assert.equal(ok.validation.valid, true);

	const missing = proposeDestination({ text: "the proxy wrapper is inline only", scope: "workstation" });
	assert.equal(missing.destination, "environment");
	assert.equal(missing.validation.valid, false);
	assert.ok(missing.validation.errors.some((e) => /source/.test(e)));
});

test("lesson requires the non-trivial rubric", () => {
	const good = proposeDestination({ text: "always use bugfix/ not fix/ for infra repo push rules" });
	assert.equal(good.destination, "lesson");
	assert.equal(good.validation.valid, true);

	const weak = proposeDestination({ text: "prefer x" }); // too short
	assert.notEqual(weak.destination, "lesson"); // classified transient, not a lesson
});

test("mission child proposed only under a focused mission", () => {
	const p = proposeDestination({ text: "root cause: bd list without --all drops closed epics", focusedMissionId: "mission-l4w" });
	assert.equal(p.destination, "mission-finding");
	assert.equal(p.validation.valid, true);

	const noFocus = proposeDestination({ text: "root cause: bd list without --all drops closed epics" });
	assert.notEqual(noFocus.destination, "mission-finding");
});

test("unrelated correction is transient, not persisted", () => {
	const p = proposeDestination({ text: "actually that looks great, thanks" });
	assert.equal(p.destination, "transient");
	assert.equal(p.validation.valid, true); // nothing to persist
	assert.equal(p.requiresReview, true);
});

test("environment capture disabled still allows mission capture", () => {
	const p = proposeDestination({
		text: "decided to reconcile by content hash",
		focusedMissionId: "mission-927",
		environmentEnabled: false,
		scope: "x",
		sources: ["y"],
	});
	// With environment disabled, scope/source do not force an environment dest.
	assert.notEqual(p.destination, "environment");
	assert.equal(p.destination, "mission-decision");
});

// --- No silent promotion / no secret persistence. ---

test("proposals always require review (no silent promotion)", () => {
	const p = proposeDestination({ text: "always never gotcha prefer durable rule here" });
	assert.equal(p.requiresReview, true);
});

test("real secret is blocked; placeholder is allowed", () => {
	const leak = proposeDestination({ text: "use AKIAIOSFODNN7EXAMPLE as the key always" });
	assert.ok(leak.secretBlocked, "AKIA-style key must be blocked");
	assert.equal(leak.validation.valid, false);

	const placeholder = proposeDestination({ text: "always set the token to <REDACTED> before committing config" });
	assert.equal(placeholder.secretBlocked, undefined);
});

// --- Duplicate proposal. ---

test("duplicate lesson key is flagged with an update suggestion", () => {
	const existing: ExistingKeys = { lessonKeys: new Set(["eks-taint-waves"]) };
	const p = proposeDestination({ text: "always roll taints in waves not all at once", key: "eks-taint-waves" }, existing);
	assert.ok(p.duplicate);
	assert.match(p.duplicate!.suggestion, /--key eks-taint-waves/);
});

// --- Reviewed environment replacement with history + invalidation. ---

function envRecord(): EnvRecord {
	return {
		id: "networking", title: "net", aliases: [],
		scopes: [{ id: "workstation", aliases: [], summary: "old proxy summary" }],
		sources: ["x"], verifiedAt: "2026-01-01", relations: [], body: "b", path: "networking.md",
	};
}

test("environment update requires review", () => {
	const plan = planEnvironmentUpdate(envRecord(), { scopeId: "workstation", summary: "new", verifiedAt: "2026-09-10" }, { reviewed: false });
	assert.equal(plan.action, "needs-review");
});

test("reviewed environment update records history and invalidates index", () => {
	const plan = planEnvironmentUpdate(envRecord(), { scopeId: "workstation", summary: "new", verifiedAt: "2026-09-10" }, { reviewed: true });
	assert.equal(plan.action, "update");
	if (plan.action === "update") {
		assert.equal(plan.invalidateIndex, true);
		assert.equal(plan.history[0].verifiedAt, "2026-01-01");
		assert.equal(plan.history[0].summary, "old proxy summary");
		assert.equal(plan.verifiedAt, "2026-09-10");
	}
});

// --- Reliable indexing (tracked retry / reconciliation). ---

test("trackedIndex succeeds without retry when the write indexes", async () => {
	const r = await trackedIndex(async () => ({ code: 0, stdout: "indexed", stderr: "" }));
	assert.equal(r.ok, true);
	assert.equal(r.action, "indexed");
	assert.equal(r.attempts, 1);
});

test("trackedIndex retries then reports pending-reconcile on repeated failure", async () => {
	let calls = 0;
	const r = await trackedIndex(async () => {
		calls++;
		return { code: 1, stdout: "", stderr: "bd not found" };
	}, { retries: 2 });
	assert.equal(r.ok, false);
	assert.equal(r.action, "pending-reconcile");
	assert.equal(calls, 3); // 1 + 2 retries
	assert.match(r.error ?? "", /bd not found/);
});

test("trackedIndex recovers on a later attempt", async () => {
	let calls = 0;
	const r = await trackedIndex(async () => {
		calls++;
		return calls < 2 ? { code: 1, stdout: "", stderr: "transient" } : { code: 0, stdout: "ok", stderr: "" };
	});
	assert.equal(r.ok, true);
	assert.equal(r.attempts, 2);
});

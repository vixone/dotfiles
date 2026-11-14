import test from "node:test";
import assert from "node:assert/strict";

import { parseResumeIntent } from "../modules/missions/extensions/mission-stack/mission-resume.ts";

// Auto-focus fires only on an anchored "Resume mission-<id>" prompt (the shape
// /land emits). These pin the matching behavior so a future edit does not start
// hijacking focus on casual mission mentions.

test("parses the epic id from a real /land resume prompt", () => {
	const prompt =
		"Resume mission-927 (Unify personal mission and memory stack) in ~/sandbox/mission-stack. Load the missions skill.";
	assert.equal(parseResumeIntent(prompt), "mission-927");
});

test("is case-insensitive and tolerates leading whitespace", () => {
	assert.equal(parseResumeIntent("  resume MISSION-8D4 now"), "mission-8d4");
});

test("folds a child id to its epic", () => {
	assert.equal(parseResumeIntent("Resume mission-927.13 and finish the cutover"), "mission-927");
});

test("does not match a casual mid-sentence mention (no hijack)", () => {
	assert.equal(parseResumeIntent("Can you look at mission-927 for me?"), null);
	assert.equal(parseResumeIntent("I want to resume the work on the argocd hub"), null);
	assert.equal(parseResumeIntent("resuming mission-927"), null);
});

test("returns null for empty or non-resume prompts", () => {
	assert.equal(parseResumeIntent(""), null);
	assert.equal(parseResumeIntent("start a new mission about eks"), null);
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test("audit reports landing wall time and top-level tool time from a session", () => {
	const home = mkdtempSync(join(tmpdir(), "land-audit-test-"));
	try {
		const session = join(home, ".pi/agent/sessions/project/2026-10-12T09-00-00Z_example.jsonl");
		mkdirSync(dirname(session), { recursive: true });
		const rows = [
			{ type: "message", timestamp: "2026-10-12T09:00:00Z", message: { role: "user", content: [{ type: "text", text: "LAND THE PLANE for the active mission(s): mission-abc." }] } },
			{ type: "message", timestamp: "2026-10-12T09:00:01Z", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "bash", id: "call-1", arguments: { command: "bd note mission-abc text" } }], usage: { output: 42 } } },
			{ type: "message", timestamp: "2026-10-12T09:00:03Z", message: { role: "toolResult", toolCallId: "call-1", toolName: "bash" } },
			{ type: "message", timestamp: "2026-10-12T09:00:05Z", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Saved." }], usage: { output: 20 } } },
		];
		writeFileSync(session, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
		const audit = join(dirname(fileURLToPath(import.meta.url)), "../scripts/audit-land.mjs");
		const result = JSON.parse(execFileSync("node", [audit, "2026-10"], {
			encoding: "utf8", env: { ...process.env, HOME: home },
		}));
		assert.equal(result.runs.length, 1);
		assert.deepEqual({
			mission: result.runs[0].mission,
			outcome: result.runs[0].outcome,
			seconds: result.runs[0].seconds,
			topLevelToolSeconds: result.runs[0].topLevelToolSeconds,
			assistantTurns: result.runs[0].assistantTurns,
			outputTokens: result.runs[0].outputTokens,
		}, { mission: "mission-abc", outcome: "complete", seconds: 5, topLevelToolSeconds: 2, assistantTurns: 2, outputTokens: 62 });
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

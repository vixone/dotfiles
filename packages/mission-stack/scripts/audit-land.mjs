import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const month = process.argv[2] ?? new Date().toISOString().slice(0, 7);
if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Usage: node scripts/audit-land.mjs [YYYY-MM]");
const root = join(homedir(), ".pi/agent/sessions");
const files = execFileSync("rg", ["--files", root, "-g", `${month}*.jsonl`], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
const runs = [];
for (const file of files) {
	const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
	for (let i = 0; i < rows.length; i++) {
		const first = rows[i];
		const text = (Array.isArray(first.message?.content) ? first.message.content : [])
			.filter((c) => c.type === "text").map((c) => c.text).join("\n");
		if (first.message?.role !== "user" || !text.startsWith("LAND THE PLANE for ")) continue;
		const run = {
			file, start: first.timestamp, mission: text.match(/mission-[a-z0-9]+/)?.[0],
			outcome: "incomplete", seconds: null, assistantTurns: 0, outputTokens: 0,
			topLevelToolSeconds: 0, calls: {},
		};
		const pending = new Map();
		for (let j = i + 1; j < rows.length; j++) {
			const row = rows[j];
			const message = row.message;
			if (message?.role === "user") {
				run.outcome = "interrupted";
				run.seconds = Math.round((Date.parse(row.timestamp) - Date.parse(first.timestamp)) / 1000);
				break;
			}
			if (message?.role === "assistant") {
				run.assistantTurns++;
				run.outputTokens += message.usage?.output ?? 0;
				for (const call of message.content?.filter((c) => c.type === "toolCall") ?? []) {
					run.calls[call.name] = (run.calls[call.name] ?? 0) + 1;
					pending.set(call.id, Date.parse(row.timestamp));
				}
				if (["stop", "error", "aborted"].includes(message.stopReason)) {
					run.outcome = message.stopReason === "stop" ? "complete" : message.stopReason;
					run.seconds = Math.round((Date.parse(row.timestamp) - Date.parse(first.timestamp)) / 1000);
					break;
				}
			}
			if (message?.role === "toolResult" && pending.has(message.toolCallId)) {
				run.topLevelToolSeconds += Math.max(0, Math.round((Date.parse(row.timestamp) - pending.get(message.toolCallId)) / 1000));
				pending.delete(message.toolCallId);
			}
		}
		runs.push(run);
	}
}
runs.sort((a, b) => b.start.localeCompare(a.start));
console.log(JSON.stringify({ month, runs }, null, 2));

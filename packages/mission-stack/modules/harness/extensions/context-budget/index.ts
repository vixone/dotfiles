/**
 * Context budget: nudge toward /continue past a soft limit, compact past a hard one.
 * Also caps bash/read output and stubs unchanged full re-reads.
 * Stands down while /continue runs (mission-stack next.ts emits CONTINUE_TOPIC): ctx.compact() aborts the
 * running turn first, which cancelled the handover, and holds /continue's waitForIdle for minutes.
 * Env: OPS_NUDGE_AT, OPS_COMPACT_AT (tokens), OPS_OUTPUT_CAP (bytes), OPS_BUDGET_DISABLED=1.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { budgetAction, capOutput, isRangedRead, COMPACT_AT, NUDGE_AT, OUTPUT_CAP, readStub, type ReadRecord } from "./budget.ts";

const KEY = "context-budget";
/** Same topic as CONTINUE_EVENT in modules/missions/extensions/mission-stack/next.ts. */
const CONTINUE_TOPIC = "mission-stack:continue";

function envNum(name: string, fallback: number): number {
	const n = Number(process.env[name]);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

const k = (n: number) => `${Math.round(n / 1000)}k`;

export default function contextBudget(pi: ExtensionAPI): void {
	if (process.env.OPS_BUDGET_DISABLED === "1") return;
	const nudgeAt = envNum("OPS_NUDGE_AT", NUDGE_AT);
	const compactAt = envNum("OPS_COMPACT_AT", COMPACT_AT);
	const outputCap = envNum("OPS_OUTPUT_CAP", OUTPUT_CAP);
	const reads = new Map<string, ReadRecord>();
	let turn = 0;
	let nudged = false;
	let compacting = false;
	let continuing = false;
	pi.events.on(CONTINUE_TOPIC, (data) => {
		continuing = typeof data === "object" && data !== null && (data as { active?: unknown }).active === true;
	});

	const clear = (ctx: ExtensionContext) => {
		nudged = false;
		if (ctx.hasUI) ctx.ui.setStatus(KEY, undefined);
	};

	// compactAllowed is false on turn_end: compaction mid-run is not confirmed
	// safe there, so compact only from agent_end.
	const evaluate = (ctx: ExtensionContext, compactAllowed: boolean) => {
		if (continuing) return;
		const action = budgetAction(ctx.getContextUsage()?.tokens ?? null, nudged, nudgeAt, compactAt);
		if (action === "nudge") {
			nudged = true;
			if (ctx.hasUI) {
				ctx.ui.notify(`Context over ${k(nudgeAt)}. Run /continue for a clean handover.`, "warning");
				ctx.ui.setStatus(KEY, `ctx >${k(nudgeAt)}: /continue`);
			}
		} else if (action === "compact" && compactAllowed && !compacting) {
			compacting = true;
			ctx.compact({
				onComplete: () => {
					compacting = false;
				},
				onError: () => {
					compacting = false;
				},
			});
		}
	};

	pi.on("session_start", async (_e, ctx) => {
		compacting = false;
		reads.clear();
		clear(ctx);
	});
	pi.on("session_compact", async (_e, ctx) => {
		reads.clear();
		compacting = false;
		clear(ctx);
	});
	// A different branch has a different transcript, so earlier reads may not be in it.
	pi.on("session_tree", async () => {
		reads.clear();
	});
	pi.on("turn_start", async () => {
		turn++;
	});
	const abs = (p: string, cwd: string) => {
		const q = p.replace(/^@/, "");
		return resolve(cwd, q === "~" ? homedir() : q.startsWith("~/") ? join(homedir(), q.slice(2)) : q);
	};
	pi.on("tool_call", async (e, ctx) => {
		const input = e.input as { path?: unknown; offset?: unknown; limit?: unknown };
		if (typeof input?.path !== "string") return;
		const p = abs(input.path, ctx.cwd);
		if (e.toolName === "edit" || e.toolName === "write") {
			reads.delete(p);
			return;
		}
		if (e.toolName !== "read") return;
		let st;
		try {
			st = statSync(p);
		} catch {
			return;
		}
		const ranged = isRangedRead(input);
		const stub = readStub(reads, p, st, turn, ranged);
		if (stub) return { block: true, reason: stub };
	});
	pi.on("tool_result", async (e) => {
		if (e.toolName !== "bash" && e.toolName !== "read") return;
		const input = e.input as { offset?: unknown; limit?: unknown };
		if (e.toolName === "read" && isRangedRead(input ?? {})) return;
		if (e.content.some((c) => c.type !== "text")) return;
		const text = e.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		if (Buffer.byteLength(text) <= outputCap) return;
		const dir = join(tmpdir(), "pi-budget");
		// Copilot tool-call ids run to ~450 chars, past the 255-byte file name limit.
		const id = createHash("sha1").update(e.toolCallId || String(Date.now())).digest("hex").slice(0, 16);
		let file: string | undefined = join(dir, `${Date.now()}-${id}.txt`);
		try {
			mkdirSync(dir, { recursive: true });
			writeFileSync(file, text);
		} catch {
			file = undefined;
		}
		const capped = capOutput(text, outputCap, file);
		return { content: [{ type: "text" as const, text: capped.text }] };
	});
	pi.on("turn_end", async (_e, ctx) => evaluate(ctx, false));
	pi.on("agent_end", async (_e, ctx) => evaluate(ctx, true));
}

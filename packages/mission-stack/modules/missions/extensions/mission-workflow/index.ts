/**
 * mission-workflow — gentle auto-activation for the mission-store workflow skills.
 *
 * The three skills (mission-wayfinder, mission-debug, mission-execute) live in
 * modules/missions/skills/ of the mission-stack pi package and are already
 * discovered natively by pi. What made the
 * old superpowers skills "activate automatically" was NOT discovery — it was a
 * per-turn bootstrap message that primed the agent to reach for them. This
 * extension recreates that priming, but with a short, non-intrusive nudge
 * instead of an EXTREMELY_IMPORTANT block.
 *
 * Mechanism (mirrors the superpowers extension, minus the skill registration):
 *   - Inject one primer message per turn (on the `context` event) until the
 *     agent finishes a turn (`agent_end`), then re-arm on the next
 *     `session_start` / `session_compact`. This keeps the nudge present without
 *     duplicating it within a single turn.
 *   - The primer is idempotent per context: if a copy is already in the message
 *     list (via its marker), we skip injection.
 *
 * Config (env):
 *   MISSION_WORKFLOW_DISABLED=1   disable the nudge entirely (escape hatch)
 *
 * Scope: loaded from the mission-stack pi package → every
 * pi session, automatically.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MARKER = "mission-workflow: skills primer";

const PRIMER = `<mission-workflow-primer>
${MARKER}

You have three mission workflow skills available.
They track everything in an mx mission instead of scattered markdown files.
Reach for them proactively when the situation fits. No need to be asked:

- mission-wayfinder. Before any creative/design work (new feature, component,
  migration, behavior change, loose idea). Charts the decisions in the way as open
  [question] children of an epic, resolves them one at a time (grilling, research
  subagents, prototypes), then lays the route down as chained [action] tasks.
  Small efforts with no open questions collapse to one session. Skip for trivial
  one-off changes.
- mission-debug. The moment a bug, test failure, or unexpected behavior appears.
  Root-cause-first. If no mission is focused, create a lightweight debug epic
  immediately (do not ask) and record findings/root-cause/fix there. Skip the
  epic only for a one-shot mechanical fix you already know without investigating.
- mission-execute. To implement a mission's [action] tasks; drives mx ready /
  mx children to closure with review checkpoints.

Load the relevant SKILL.md with \`read\` when it applies. Skip wayfinder/execute
ceremony for genuinely trivial tasks. For bugs, follow mission-debug. A
lightweight epic is the default, not ceremony.
</mission-workflow-primer>`;

export default function missionWorkflow(pi: ExtensionAPI): void {
	if (process.env.MISSION_WORKFLOW_DISABLED === "1") return;

	let injectPrimer = true;

	pi.on("session_start", async () => {
		injectPrimer = true;
	});

	pi.on("session_compact", async () => {
		injectPrimer = true;
	});

	pi.on("agent_end", async () => {
		injectPrimer = false;
	});

	pi.on("context", async (event) => {
		if (!injectPrimer) return;
		if (event.messages.some(messageHasPrimer)) return;

		const primerMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: PRIMER }],
			timestamp: Date.now(),
		};

		const insertAt = firstNonCompactionSummaryIndex(event.messages);
		return {
			messages: [
				...event.messages.slice(0, insertAt),
				primerMessage,
				...event.messages.slice(insertAt),
			],
		};
	});
}

function messageHasPrimer(message: unknown): boolean {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content.includes(MARKER);
	if (!Array.isArray(content)) return false;
	return content.some(
		(part) =>
			part &&
			typeof part === "object" &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string" &&
			(part as { text: string }).text.includes(MARKER),
	);
}

function firstNonCompactionSummaryIndex(messages: unknown[]): number {
	let index = 0;
	while ((messages[index] as { role?: unknown } | undefined)?.role === "compactionSummary") {
		index += 1;
	}
	return index;
}

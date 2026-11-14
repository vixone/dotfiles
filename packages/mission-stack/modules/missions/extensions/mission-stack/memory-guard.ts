/**
 * memory-guard
 *
 * Async contextual memory surfacing on infrastructure commands.
 *
 * Two trigger modes:
 *
 * 1. MUTATION GUARD — When the agent runs a mutating bash command
 *    (terraform apply, kubectl apply, helm upgrade), searches memory
 *    and appends relevant lessons to the tool result.
 *
 * 2. ERROR RECOVERY — When a bash command fails, searches memory for
 *    the error text to surface known fixes. Highest-value trigger:
 *    answers "have we solved this before?"
 *
 * Design:
 * - Extracts topic from command/error output
 * - Searches graph via memory-client (shared sibling module)
 * - Appends as "💡 Memory:" block to tool result content
 * - Skips if graph is unavailable or returns nothing
 * - Score threshold: 0.70 for both mutations and errors
 *
 * Phase 1.1 refactor: factored env-vars / paths / exec into ./memory-client.ts.
 * No behavior change — same triggers, same thresholds, same output format.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isBashToolResult } from "@earendil-works/pi-coding-agent";

import { createMemoryClient } from "./memory-client.ts";
import { type MemoryHit } from "./memory-contract.ts";
import { type Coordinator } from "./context-coordinator.ts";

// --------------------------------------------------------------------------
// Shared: filter memory results by confidence threshold
// --------------------------------------------------------------------------
// formatLessonHits renders the most actionable lessons (mission work skipped)
// from structured memory-v1 hits into a Markdown snippet, applying a score
// floor and dropping the low-signal "memory" domain. Replaces the old Markdown
// regex scraping (mission-927.8).
function formatLessonHits(hits: MemoryHit[], threshold: number): string | null {
	const lessons = hits.filter(
		(h) => h.type === "lesson" && h.score >= threshold && h.domain !== "memory",
	);
	if (lessons.length === 0) return null;
	return lessons
		.map((h) => `- **[${h.score.toFixed(2)}]** \`${h.key}\`${h.domain ? ` (${h.domain})` : ""}\n  ${h.excerpt}`)
		.join("\n");
}

// --------------------------------------------------------------------------
// Trigger 2: Error recovery — extract searchable context from failed commands
// --------------------------------------------------------------------------
// Read-only commands that fail harmlessly — never worth searching memory for
const READ_ONLY_COMMANDS = /^\s*(cat|ls|find|grep|rg|head|tail|wc|file|stat|du|df|which|type|echo|printf|date|whoami|id|pwd|env|printenv|jq|yq|column|sort|uniq|tr|cut|awk|sed\s+-n)\b/;

function extractErrorContext(command: string, output: string): string | null {
	// Skip very short or empty output
	if (!output || output.length < 20) return null;

	// Skip multi-line scripts (same as mutation guard)
	const lines = command.trim().split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
	if (lines.length > 6) return null;

	// Skip read-only commands — their failures are never knowledge-graph-worthy
	const lastCmd = lines[lines.length - 1] ?? command;
	if (READ_ONLY_COMMANDS.test(lastCmd)) return null;

	// Route by command context first to avoid cross-matching
	const isTerraform = /terraform\s/i.test(command);
	const isKubectl = /kubectl\s/i.test(command);
	const isGit = /git\s+(push|pull|merge|rebase|branch|checkout)/i.test(command);
	const isHelm = /helm\s/i.test(command);
	const isAws = /aws\s+\w/i.test(command);

	// Terraform errors (│ prefix from terraform output)
	if (isTerraform) {
		const tfError = output.match(/│?\s*Error:\s*(.+?)(?:\n|$)/i);
		if (tfError) {
			const parts: string[] = ["terraform"];
			// Add resource type if present
			const resource = output.match(/resource\s+"([^"]+)"/i);
			if (resource) parts.push(resource[1]);
			// Add variable name if present
			const varName = output.match(/variable\s+"([^"]+)"/i);
			if (varName) parts.push(varName[1]);
			// Add error summary
			parts.push(tfError[1]);
			// Grab additional context lines (│ prefixed, non-empty)
			const contextLines = output.match(/│\s+(.{10,80})/g);
			if (contextLines) {
				// Take last 2 context lines (usually the most specific)
				const useful = contextLines
					.map(l => l.replace(/^│\s+/, "").trim())
					.filter(l => !l.startsWith("on ") && !l.match(/^\d+:/))
					.slice(-2);
				parts.push(...useful);
			}
			return parts.join(" ").slice(0, 250);
		}
	}

	// kubectl errors
	if (isKubectl) {
		const k8sError = output.match(/error[:\s]+(.+?)(?:\n|$)/i);
		if (k8sError) return `kubernetes ${k8sError[1]}`.slice(0, 200);
	}

	// git errors
	if (isGit) {
		const gitError = output.match(/(?:error|fatal|rejected):\s*(.+?)(?:\n|$)/i);
		if (gitError) return `git ${gitError[1]}`.slice(0, 200);
	}

	// helm errors
	if (isHelm) {
		const helmError = output.match(/Error:\s*(.+?)(?:\n|$)/i);
		if (helmError) return `helm ${helmError[1]}`.slice(0, 200);
	}

	// AWS CLI errors
	if (isAws) {
		const awsError = output.match(/(?:An error occurred|InvalidParameter|AccessDenied|ValidationError)\s*\(?([^)\n]+)\)?[:\s]*(.+?)(?:\n|$)/i);
		if (awsError) return `AWS ${awsError[1]} ${awsError[2]}`.slice(0, 200);
	}

	// Python errors — skip trivial dependency issues, reformulate others
	const isPython = /python[23]?\s/i.test(command) || /\.py\b/.test(command);
	if (isPython) {
		// ModuleNotFoundError / ImportError with "No module named" = pip install, never useful
		if (/ModuleNotFoundError|No module named/i.test(output)) return null;
		const pyError = output.match(/(AttributeError|TypeError|FileNotFoundError|PermissionError|ValueError|KeyError|RuntimeError|ImportError):\s*(.+?)(?:\n|$)/);
		if (pyError) return `python ${pyError[1]} ${pyError[2]}`.slice(0, 200);
	}

	// Generic: use last meaningful error line + command base
	const lastLines = output.trim().split("\n").filter(l => l.trim()).slice(-3);
	const errorLine = lastLines.find(l => /error|fail|denied|invalid|cannot|unable/i.test(l)) ?? lastLines.pop() ?? "";
	if (errorLine.length > 15) {
		const baseCmd = command.match(/(?:^|\|\s*|&&\s*)([a-z][a-z0-9_-]+)/i)?.[1] ?? "";
		return `${baseCmd} ${errorLine}`.slice(0, 200);
	}

	return null;
}

// --------------------------------------------------------------------------
// Trigger 1: Mutation guard — mutating command patterns
// --------------------------------------------------------------------------
const MUTATING_PATTERNS: { regex: RegExp; extractor: (cmd: string) => string | null }[] = [
	{
		// kubectl apply/delete/annotate/patch/create/scale/rollout
		regex: /kubectl\s+(apply|delete|annotate|patch|create|scale|rollout|replace|label|taint)/,
		extractor: (cmd) => {
			const ns = cmd.match(/-n\s+(\S+)|--namespace[= ](\S+)/);
			const resource = cmd.match(/(?:apply|delete|annotate|patch|create|scale|rollout|replace|label|taint)\s+(\S+)/);
			const parts: string[] = [];
			if (ns) parts.push(ns[1] || ns[2]);
			if (resource) parts.push(resource[1]);
			// Also grab -f filename for apply
			const file = cmd.match(/-f\s+(\S+)/);
			if (file) parts.push(file[1].replace(/.*\//, "").replace(/\.(ya?ml|json)$/, ""));
			return parts.length > 0 ? parts.join(" ") : null;
		},
	},
	{
		// helm upgrade/install/uninstall/rollback
		regex: /helm\s+(upgrade|install|uninstall|rollback)/,
		extractor: (cmd) => {
			const ns = cmd.match(/-n\s+(\S+)|--namespace[= ](\S+)/);
			// helm upgrade RELEASE CHART
			const parts = cmd.match(/helm\s+\w+\s+(\S+)\s+(\S+)/);
			const pieces: string[] = [];
			if (ns) pieces.push(ns[1] || ns[2]);
			if (parts) {
				pieces.push(parts[1]); // release name
				pieces.push(parts[2].replace(/.*\//, "")); // chart name
			}
			return pieces.length > 0 ? pieces.join(" ") : null;
		},
	},
	{
		// terraform apply/destroy/import
		regex: /terraform\s+(apply|destroy|import)/,
		extractor: (cmd) => {
			// Try to get the tfvars file or resource
			const tfvars = cmd.match(/-var-file[= ](\S+)/);
			const resource = cmd.match(/import\s+(\S+)/);
			if (tfvars) return tfvars[1].replace(/.*\//, "").replace(/\.tfvars$/, "");
			if (resource) return resource[1];
			// Fall back to directory name
			return "terraform infrastructure";
		},
	},
	// NOTE: `mx remember` is intentionally NOT in this list. Dedup is the
	// agent's job via `memory_check_duplicate` (calibrated merge/likely/related verdict).
	// memory-guard's generic `memory_search` returned tangential 0.66 hits —
	// pure noise. See the memory skill "Before mx remember".
	{
		// argocd app sync/delete/set/patch
		regex: /argocd\s+app\s+(sync|delete|set|patch|create)/,
		extractor: (cmd) => {
			const app = cmd.match(/app\s+\w+\s+(\S+)/);
			return app ? `argocd ${app[1]}` : "argocd application";
		},
	},
	{
		// aws iam — role/policy mutations
		regex: /aws\s+iam\s+(create-role|attach-role-policy|put-role-policy|create-policy|update-assume-role)/,
		extractor: (cmd) => {
			const role = cmd.match(/--role-name\s+(\S+)/);
			const policy = cmd.match(/--policy-arn\s+(\S+)/);
			const parts: string[] = ["IAM role"];
			if (role) parts.push(role[1]);
			if (policy) parts.push(policy[1].replace(/.*\//, ""));
			return parts.join(" ");
		},
	},
	{
		// aws eks — cluster/nodegroup/addon mutations
		regex: /aws\s+eks\s+(create|update|delete|associate)/,
		extractor: (cmd) => {
			const cluster = cmd.match(/--cluster-name\s+(\S+)/);
			const resource = cmd.match(/eks\s+(\S+)/);
			const parts: string[] = ["EKS"];
			if (resource) parts.push(resource[1]);
			if (cluster) parts.push(cluster[1]);
			return parts.join(" ");
		},
	},
];

function extractSearchQuery(command: string): string | null {
	// Skip multi-line scripts (loops, heredocs, functions) — they often
	// contain mutating keywords inside read-only audit scripts. Only fire
	// on direct single-command invocations.
	const lines = command.trim().split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
	if (lines.length > 4) return null;

	for (const { regex, extractor } of MUTATING_PATTERNS) {
		if (regex.test(command)) {
			return extractor(command);
		}
	}
	return null;
}

/**
 * Register memory-guard's tool_result handler. Called from the umbrella
 * extension's index.ts. Behavior is unchanged from the pre-Phase-1.1 file.
 */
export function registerMemoryGuard(pi: ExtensionAPI, coordinator?: Coordinator): void {
	const memory = createMemoryClient(pi.exec.bind(pi));

	pi.on("tool_result", async (event, ctx) => {
		if (!isBashToolResult(event)) return;

		const command = typeof event.input === "object" && event.input !== null
			? (event.input as { command?: string }).command ?? ""
			: "";

		if (!command) return;

		// Extract existing output text (needed by both triggers)
		const existingContent = Array.isArray(event.content) ? event.content : [];
		const existingText = existingContent
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");

		// ===================================================================
		// Trigger 2: Error recovery — search memory for known fixes
		// ===================================================================
		if (event.isError) {
			const errorQuery = extractErrorContext(command, existingText);
			if (!errorQuery) return;

			try {
				let filtered: string | null;
				if (coordinator) {
					// Submit an error signal to the shared selector (env-exact first,
					// shared dedup/budget/degradation).
					const sel = await coordinator.select("error", errorQuery, { signal: ctx.signal });
					if (!sel.inject) return;
					filtered = sel.items
						.map((it) => `- **[${(it.score ?? 1).toFixed(2)}]** \`${it.key}\`\n  ${it.text}`)
						.join("\n");
				} else {
					const parsed = await memory.searchStructured(errorQuery, { signal: ctx.signal });
					if (!parsed.ok) return;
					// Threshold 0.86 for errors — eliminates cross-domain noise (0.84-0.85 range)
					filtered = formatLessonHits(parsed.envelope.hits ?? [], 0.86);
				}
				if (!filtered) return;

				const memoryNote = [
					"",
					"---",
					"💡 **Known fixes** (from knowledge graph):",
					"",
					filtered,
				].join("\n");

				return {
					content: [{ type: "text", text: existingText + memoryNote }],
				};
			} catch {
				return;
			}
		}

		// ===================================================================
		// Trigger 1: Mutation guard — search memory for relevant context
		// ===================================================================
		const searchQuery = extractSearchQuery(command);
		if (!searchQuery) return;

		try {
			const parsed = await memory.searchStructured(searchQuery, { signal: ctx.signal });
			if (!parsed.ok) return;

			const filtered = formatLessonHits(parsed.envelope.hits ?? [], 0.70);
			if (!filtered) return;

			const memoryNote = [
				"",
				"---",
				"💡 **Memory context** (from knowledge graph):",
				"",
				filtered,
			].join("\n");

			return {
				content: [{ type: "text", text: existingText + memoryNote }],
			};
		} catch {
			// Graph unavailable — silently skip
			return;
		}
	});
}

/**
 * guards — one extension, one tool_call hook, many guards.
 *
 * Consolidates the former push-guard + commit-guard extensions and adds a
 * terraform guard. Each guard is a self-contained module (push.ts, commit.ts,
 * terraform.ts) sharing one quote-aware parser (shell.ts). Adding a future
 * guard = new module + one dispatch block here.
 *
 * All guards enforce policy at the tool-call layer (fires before a tool runs,
 * can block) — real gates, not advisory markdown.
 *
 * Behaviour per guard:
 *   push       — protected-branch push → confirm (UI) / block (headless).
 *   commit     — malformed subject     → always block (rewrite is the fix).
 *   terraform  — apply/destroy         → confirm (UI) / block (headless).
 *                (`apply -refresh-only` is allowed — state-only, drift-fix.)
 *
 * Config (env):
 *   GUARDS_DISABLED=1                     master switch — disable ALL guards
 *   PUSH_GUARD_DISABLED=1                 disable push guard
 *   PUSH_GUARD_PROTECTED=main,master,prod protected branch names
 *   COMMIT_GUARD_DISABLED=1               disable commit guard
 *   COMMIT_GUARD_MAX=50                   max commit subject length
 *   TF_GUARD_DISABLED=1                   disable terraform guard
 *
 * Scope: loaded from the mission-stack pi package → every session,
 * every project, automatically.
 */

import type { ExtensionAPI, ToolCallEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { guardsDisabled } from "./shell.ts";
import { pushDisabled, evaluatePush } from "./push.ts";
import { commitDisabled, maxLen, evaluateCommit } from "./commit.ts";
import { tfDisabled, evaluateTerraform } from "./terraform.ts";

export default function (pi: ExtensionAPI): void {
	if (guardsDisabled()) return;

	pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
		if (!isToolCallEventType("bash", event)) return;
		const command = event.input.command ?? "";
		if (!command) return;

		// --- commit guard: always hard-block a bad subject -------------------
		if (!commitDisabled() && /\bgit\b/.test(command) && /\bcommit\b/.test(command)) {
			let reason: string | null = null;
			try { reason = evaluateCommit(command, maxLen()); } catch { reason = null; }
			if (reason) {
				return {
					block: true,
					reason:
						`🛑 commit-guard: ${reason}\n\n` +
						`Rewrite with a tight, subject-only message (<= ${maxLen()} chars, ASCII ` +
						`hyphen, no AI attribution). Put context in the PR description, not the ` +
						`commit. Bypass for this session: COMMIT_GUARD_DISABLED=1.`,
				};
			}
		}

		// --- terraform guard: confirm (UI) / block (headless) ----------------
		if (!tfDisabled() && /\bterraform\b/.test(command) && /\b(apply|destroy)\b/.test(command)) {
			let tf = null;
			try { tf = evaluateTerraform(command); } catch { tf = null; }
			if (tf) {
				const aa = tf.autoApprove ? " -auto-approve" : "";
				if (!ctx.hasUI) {
					return {
						block: true,
						reason:
							`🛑 tf-guard: blocked \`terraform ${tf.action}${aa}\`. Local apply/destroy ` +
							`must never mutate cloud resources — that's the CI/CD pipeline's job. ` +
							`(refresh-only apply is allowed.) No UI to approve in this mode. Bypass: ` +
							`TF_GUARD_DISABLED=1.`,
					};
				}
				const ok = await ctx.ui.confirm(
					`🛑 terraform ${tf.action}`,
					`This command runs a state-mutating Terraform op:\n${tf.command}\n\n` +
					`Local apply/destroy is the pipeline's job, not yours. ` +
					`Allow this ${tf.action} anyway?`,
				);
				if (!ok) {
					return {
						block: true,
						reason:
							`tf-guard: you declined \`terraform ${tf.action}\`. Let the CI/CD pipeline ` +
							`apply. For state refresh use \`terraform apply -refresh-only\`.`,
					};
				}
			}
		}

		// --- push guard: confirm (UI) / block (headless) ---------------------
		if (!pushDisabled() && /\bgit\b/.test(command) && /\bpush\b/.test(command)) {
			let verdict = null;
			try { verdict = await evaluatePush(pi, command, ctx.cwd, ctx.signal); } catch { verdict = null; }
			if (verdict?.blocked) {
				const branchList = verdict.pushesAll
					? "ALL branches (--all/--mirror includes protected branches)"
					: verdict.targets.join(", ");
				const forceNote = verdict.force ? " (FORCE push!)" : "";

				if (!ctx.hasUI) {
					return {
						block: true,
						reason:
							`🛑 push-guard: blocked push to protected branch [${branchList}]${forceNote}. ` +
							`No interactive UI to approve in this mode. Re-run interactively and approve, ` +
							`or set PUSH_GUARD_DISABLED=1 for this session.`,
					};
				}
				const ok = await ctx.ui.confirm(
					`🛑 Push to protected branch${forceNote}`,
					`This command pushes to: ${branchList}\n\n` +
					`Command:\n${command}\n\n` +
					`Allow this push to a protected branch?`,
				);
				if (!ok) {
					return {
						block: true,
						reason:
							`push-guard: you declined the push to [${branchList}]. ` +
							`Work on a feature branch and open a PR instead.`,
					};
				}
			}
		}
	});
}

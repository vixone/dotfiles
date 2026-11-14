/**
 * terraform.ts — guard logic for state-mutating Terraform commands.
 *
 * Hard rule (see ~/.pi/agent/CLAUDE.md "Terraform / IaC Onboarding Safety"):
 * `terraform apply` and `terraform destroy` must never mutate real cloud
 * resources from a local shell — that is the CI/CD pipeline's job. This guard
 * catches those commands in a bash invocation.
 *
 * IMPORTANT EXCEPTION — refresh-only apply is ALLOWED:
 *   `terraform apply -refresh-only [-auto-approve]` only reconciles LOCAL
 *   state to live AWS reality; it never changes infrastructure. The
 *   tf-drift-fix skill (ADR-4 / CON-2) uses it routinely as the official
 *   replacement for the deprecated `terraform refresh`. So an apply is gated
 *   ONLY when `-refresh-only` is absent.
 *
 * index.ts turns the verdict into a confirm dialog (interactive) or a hard
 * block (headless).
 *
 * Config (env):
 *   TF_GUARD_DISABLED=1   disable just this guard
 */

import { splitSegments, tokenize } from "./shell.ts";

export function tfDisabled(): boolean {
	return process.env.TF_GUARD_DISABLED === "1";
}

export type TfVerdict = { action: "apply" | "destroy"; command: string; autoApprove: boolean };

/** Inspect one tokenized segment. Returns a verdict if it's a gated terraform
 * command, else null. Allows `apply -refresh-only`. */
export function parseTfSegment(tokens: string[]): TfVerdict | null {
	const ti = tokens.findIndex((t) => t === "terraform");
	if (ti === -1) return null;

	// First non-flag token after `terraform` is the subcommand.
	let sub: string | undefined;
	let si = -1;
	for (let k = ti + 1; k < tokens.length; k++) {
		const t = tokens[k];
		if (t.startsWith("-")) continue; // global flags (-chdir=..., etc.)
		sub = t; si = k; break;
	}
	if (sub !== "apply" && sub !== "destroy") return null;

	const rest = tokens.slice(si + 1);
	const refreshOnly = rest.includes("-refresh-only") || rest.includes("--refresh-only");
	const autoApprove = rest.includes("-auto-approve") || rest.includes("--auto-approve");

	// refresh-only apply is state-only → never gated.
	if (sub === "apply" && refreshOnly) return null;

	return { action: sub, command: tokens.join(" "), autoApprove };
}

/** Evaluate a full bash command. Returns the first gated terraform verdict, or
 * null if none. */
export function evaluateTerraform(command: string): TfVerdict | null {
	for (const segment of splitSegments(command)) {
		const tokens = tokenize(segment);
		if (!tokens.includes("terraform")) continue;
		const verdict = parseTfSegment(tokens);
		if (verdict) return verdict;
	}
	return null;
}

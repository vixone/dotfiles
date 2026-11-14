/**
 * Unit tests for the guards suite. SDK-free logic only. Run standalone:
 *   node --experimental-strip-types test.ts
 */

import { parsePushSegment, evaluatePush } from "./push.ts";
import { evaluateCommit, parseCommitSegment } from "./commit.ts";
import { evaluateTerraform } from "./terraform.ts";
import { tokenize } from "./shell.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = "") {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
}

// Fake pi: reports current branch based on the cwd it's invoked with, so
// cross-segment `cd` handling is actually exercised. Map of cwd → branch.
function fakePiByCwd(branchByCwd: Record<string, string>, fallback = "feature/x"): ExtensionAPI {
	return {
		exec: async (_cmd: string, args: string[], opts?: { cwd?: string }) => {
			const branch = branchByCwd[opts?.cwd ?? ""] ?? fallback;
			if (args.includes("@{push}")) {
				return { stdout: "", stderr: "", code: 1, killed: false };
			}
			if (args.includes("HEAD")) {
				return { stdout: branch, stderr: "", code: 0, killed: false };
			}
			return { stdout: "", stderr: "", code: 1, killed: false };
		},
	} as unknown as ExtensionAPI;
}

// Simpler fake: reports current branch / push target regardless of cwd.
function fakePi(currentBranch: string, pushTarget?: string): ExtensionAPI {
	return {
		exec: async (_cmd: string, args: string[]) => {
			if (args.includes("@{push}")) {
				return { stdout: pushTarget ?? "", stderr: "", code: pushTarget ? 0 : 1, killed: false };
			}
			if (args.includes("HEAD")) {
				return { stdout: currentBranch, stderr: "", code: 0, killed: false };
			}
			return { stdout: "", stderr: "", code: 1, killed: false };
		},
	} as unknown as ExtensionAPI;
}

async function main() {
	// ---- push -------------------------------------------------------------
	console.log("push:");
	ok("explicit push to main → parsed dst main",
		parsePushSegment(tokenize("git push origin feature:main"))?.explicitDsts.join() === "main");
	ok("bare push on main → blocked",
		(await evaluatePush(fakePi("main"), "git push", "/tmp"))?.blocked === true);
	ok("bare push on feature → allowed",
		(await evaluatePush(fakePi("feature/x"), "git push", "/tmp")) === null);
	ok("push --all → blocked",
		(await evaluatePush(fakePi("feature/x"), "git push --all", "/tmp"))?.pushesAll === true);
	ok("cd x && git push (on master) → blocked",
		(await evaluatePush(fakePi("master"), "cd repo && git push", "/tmp"))?.blocked === true);
	// Regression: cross-SEGMENT cd (`cd repo; git push`) must resolve the branch
	// in /tmp/repo, not the base cwd. Caught live, not by the old space-split test.
	ok("cd repo; git push resolves branch in repo cwd → blocked",
		(await evaluatePush(
			fakePiByCwd({ "/base/repo": "main" }, "feature/x"),
			"cd repo; git push", "/base"))?.blocked === true);
	ok("cd repo; git push where repo is on feature → allowed",
		(await evaluatePush(
			fakePiByCwd({ "/base/repo": "feature/y" }, "main"),
			"cd repo; git push", "/base")) === null);

	// ---- commit -----------------------------------------------------------
	console.log("commit:");
	ok("short clean subject → ok",
		evaluateCommit('git commit -m "feat(x): add thing"', 50) === null);
	ok("over-long subject → blocked",
		evaluateCommit('git commit -m "feat(x): ' + "a".repeat(60) + '"', 50) !== null);
	ok("em-dash subject → blocked",
		evaluateCommit('git commit -m "feat: a — b"', 50) !== null);
	ok("AI attribution in subject → blocked",
		evaluateCommit('git commit -m "feat: x assisted by Claude"', 50) !== null);
	ok("attribution only in body → not subject's concern (allowed)",
		evaluateCommit('git commit -m "feat: x\n\nCo-Authored-By: Claude"', 50) === null);
	ok("-qam subject then -m long body → ok",
		evaluateCommit('git commit -qam "feat(x): short subject" -m "- a body line that is long enough to exceed fifty characters total"', 50) === null);
	ok("-am over-long subject → blocked",
		evaluateCommit('git commit -am "feat(x): ' + "a".repeat(60) + '"', 50) !== null);
	ok("-amfoo attached message → subject foo",
		parseCommitSegment(tokenize('git commit -amfoo -m bar'))?.kind === "subject" &&
		(parseCommitSegment(tokenize('git commit -amfoo -m bar')) as any).subject === "foo");
	ok("--amend (editor) → allowed",
		evaluateCommit("git commit --amend", 50) === null);

	// ---- terraform --------------------------------------------------------
	console.log("terraform:");
	ok("terraform apply → gated",
		evaluateTerraform("terraform apply")?.action === "apply");
	ok("terraform apply -auto-approve → gated + autoApprove",
		evaluateTerraform("terraform apply -auto-approve")?.autoApprove === true);
	ok("terraform destroy → gated",
		evaluateTerraform("terraform destroy -auto-approve")?.action === "destroy");
	ok("terraform apply plan.tfplan → gated",
		evaluateTerraform("terraform apply plan.tfplan") !== null);
	ok("terraform apply -refresh-only → ALLOWED (drift-fix)",
		evaluateTerraform("terraform apply -refresh-only -auto-approve") === null);
	ok("terraform plan → allowed",
		evaluateTerraform("terraform plan -out=p") === null);
	ok("terraform import → allowed",
		evaluateTerraform("terraform import aws_s3_bucket.b my-bucket") === null);
	ok("cd dir && terraform apply → gated",
		evaluateTerraform("cd infra && terraform apply") !== null);
	ok("terraform -chdir=x apply → gated",
		evaluateTerraform("terraform -chdir=infra apply")?.action === "apply");

	console.log(`\n${pass} passed, ${fail} failed`);
	if (fail > 0) process.exit(1);
}

main();

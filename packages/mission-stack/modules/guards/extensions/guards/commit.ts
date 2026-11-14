/**
 * commit.ts — guard logic for malformed git commit subjects.
 *
 * GitHub's PR auto-fill takes the commit SUBJECT as the PR title and spills any
 * overflow (past ~72 chars) into the PR body, so a long subject yields a
 * truncated title and a stray body fragment. This guard rejects a commit whose
 * subject exceeds the max length, contains an em-dash, or carries AI
 * attribution — checked before the commit runs, blocked outright (the fix is to
 * rewrite the message).
 *
 * Config (env):
 *   COMMIT_GUARD_DISABLED=1   disable just this guard
 *   COMMIT_GUARD_MAX=50       max subject length (default 50)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { splitSegments, tokenize } from "./shell.ts";

export function commitDisabled(): boolean {
	return process.env.COMMIT_GUARD_DISABLED === "1";
}

export function maxLen(): number {
	const raw = process.env.COMMIT_GUARD_MAX;
	const n = raw ? parseInt(raw, 10) : NaN;
	return Number.isFinite(n) && n > 0 ? n : 50;
}

export type CommitSubjectResult =
	| { kind: "subject"; subject: string }
	| { kind: "skip" }
	| null;

// Flags on `git commit` that consume the following token as a value but are
// NOT the message.
const VALUE_FLAGS = new Set([
	"--author", "--date", "--cleanup", "-S", "--gpg-sign", "-u", "--untracked-files",
	"--pathspec-from-file", "--gpg-sign=",
]);

// Flags that mean "reuse an existing message" → subject not from this command.
const REUSE_FLAGS = new Set(["-C", "--reuse-message", "-c", "--reedit-message", "--squash", "--fixup"]);

export function parseCommitSegment(tokens: string[]): CommitSubjectResult {
	const gi = tokens.findIndex((t) => t === "git");
	if (gi === -1) return null;

	let ci = -1;
	for (let k = gi + 1; k < tokens.length; k++) {
		const t = tokens[k];
		if (t === "-C" && k + 1 < tokens.length) { k++; continue; }
		if (t === "-c" && k + 1 < tokens.length) { k++; continue; }
		if (t.startsWith("-")) continue;
		if (t === "commit") { ci = k; break; }
		return null;
	}
	if (ci === -1) return null;

	const args = tokens.slice(ci + 1);
	let msg: string | undefined;

	for (let k = 0; k < args.length; k++) {
		const a = args[k];
		if ((a === "-m" || a === "--message") && k + 1 < args.length && msg === undefined) {
			msg = args[++k]; continue;
		}
		if (/^-[A-Za-z]+$/.test(a) && msg === undefined) {
			const mi = a.slice(1).search(/[mCcFt]/) + 1;
			if (mi > 0 && a[mi] === "m") {
				if (mi + 1 < a.length) { msg = a.slice(mi + 1); continue; }
				if (k + 1 < args.length) { msg = args[++k]; continue; }
			}
		}
		if (a.startsWith("-m") && a.length > 2 && msg === undefined) { msg = a.slice(2); continue; }
		if (a.startsWith("--message=") && msg === undefined) { msg = a.slice("--message=".length); continue; }
		if ((a === "-F" || a === "--file") && k + 1 < args.length && msg === undefined) {
			msg = readFileFirstLine(args[++k]); continue;
		}
		if (a.startsWith("--file=") && msg === undefined) { msg = readFileFirstLine(a.slice("--file=".length)); continue; }
		if (REUSE_FLAGS.has(a)) { if (!a.includes("=")) k++; continue; }
		if (a === "-t" || a === "--template") { k++; continue; }
		if (VALUE_FLAGS.has(a) && k + 1 < args.length) { k++; continue; }
	}

	if (msg === undefined) return { kind: "skip" };            // editor/amend/reuse
	if (/\$\(|`/.test(msg)) return { kind: "skip" };            // command substitution → can't judge
	return { kind: "subject", subject: msg.split("\n")[0] };
}

function readFileFirstLine(file: string): string | undefined {
	try {
		const p = file.startsWith("/") ? file : path.resolve(process.cwd(), file);
		return fs.readFileSync(p, "utf8").split("\n")[0];
	} catch {
		return undefined;
	}
}

const AI_ATTRIB = /co-authored-by:|generated with|🤖|assisted by (claude|gpt|copilot|an ai)|\bclaude(\.ai| code)?\b|\bgpt-?[0-9]/i;

export function checkSubject(subject: string, limit: number): string | null {
	const s = subject.trim();
	if (s.length === 0) return null;
	if (s.length > limit) {
		return `commit subject is ${s.length} chars (max ${limit}). GitHub uses the ` +
			`subject as the PR title and spills the overflow into the PR body. ` +
			`Shorten it:\n  "${s}"`;
	}
	if (s.includes("\u2014")) {
		return `commit subject contains an em-dash (—, U+2014). Use a plain ASCII ` +
			`hyphen "-":\n  "${s}"`;
	}
	if (AI_ATTRIB.test(s)) {
		return `commit subject carries AI-attribution. Remove it:\n  "${s}"`;
	}
	return null;
}

/** Evaluate a full bash command. Returns a violation reason, or null if clean
 * / not a git commit. */
export function evaluateCommit(command: string, limit: number): string | null {
	for (const segment of splitSegments(command)) {
		const tokens = tokenize(segment);
		if (!tokens.includes("commit")) continue;
		const res = parseCommitSegment(tokens);
		if (!res || res.kind !== "subject") continue;
		const violation = checkSubject(res.subject, limit);
		if (violation) return violation;
	}
	return null;
}

/**
 * shell.ts — shared, SDK-free shell-command parsing for all guards.
 *
 * Both the push and commit guards need the same quote-aware primitives:
 * split a compound command into segments, tokenize a segment, and normalise
 * a git ref to its basename. This module is the single source of truth so the
 * three-plus guards can't drift apart.
 */

/** Split a compound shell command into segments on `;`, `&&`, `||`, `|`,
 * and newlines — quote-aware so separators inside strings are ignored. */
export function splitSegments(command: string): string[] {
	const placeholders: string[] = [];
	const stripped = command.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, (m) => {
		placeholders.push(m);
		return `\u0001${placeholders.length - 1}\u0001`;
	});
	return stripped
		.split(/(?:&&|\|\||;|\||\n)/)
		.map((p) => p.replace(/\u0001(\d+)\u0001/g, (_, i) => placeholders[Number(i)]));
}

/** Quote-aware tokenizer (single/double quotes, backslash escapes). */
export function tokenize(segment: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	const n = segment.length;
	while (i < n) {
		while (i < n && /\s/.test(segment[i])) i++;
		if (i >= n) break;
		let token = "";
		while (i < n && !/\s/.test(segment[i])) {
			const c = segment[i];
			if (c === "'") {
				const end = segment.indexOf("'", i + 1);
				if (end === -1) { token += segment.slice(i + 1); i = n; }
				else { token += segment.slice(i + 1, end); i = end + 1; }
			} else if (c === '"') {
				let j = i + 1;
				while (j < n && segment[j] !== '"') {
					if (segment[j] === "\\" && j + 1 < n) { token += segment[j + 1]; j += 2; }
					else { token += segment[j]; j++; }
				}
				i = j + 1;
			} else if (c === "\\" && i + 1 < n) {
				token += segment[i + 1]; i += 2;
			} else {
				token += c; i++;
			}
		}
		tokens.push(token);
	}
	return tokens;
}

/** Basename of a ref: refs/heads/main → main, +main → main. */
export function refBasename(ref: string): string {
	let r = ref.replace(/^\+/, "");             // strip force '+'
	r = r.replace(/^refs\/(heads|tags)\//, ""); // strip full-ref prefix
	const slash = r.lastIndexOf("/");
	return slash === -1 ? r : r.slice(slash + 1);
}

/** Extract a leading `cd <dir>` target from a segment's tokens. */
export function extractCd(tokens: string[]): string | undefined {
	const ci = tokens.findIndex((t) => t === "cd");
	if (ci !== -1 && ci + 1 < tokens.length && !tokens[ci + 1].startsWith("-")) {
		return tokens[ci + 1];
	}
	return undefined;
}

/** Master kill switch for the whole guards suite. */
export function guardsDisabled(): boolean {
	return process.env.GUARDS_DISABLED === "1";
}

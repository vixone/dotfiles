/**
 * Turns footer statuses (ctx.ui.setStatus key/text) into HUD rows. Known keys
 * get a short label and their own coloring; anything else falls back to the
 * key as label. Colors are theme token names, painted by the view, so a
 * status's own ANSI styling is dropped and ghost mode can dim it.
 */

export type Tone = "accent" | "text" | "muted" | "warning" | "error" | "success";
export type Part = { text: string; tone: Tone };
export type StatusRow = { label: string; parts: Part[] };

const ANSI = /\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(s: string): string {
	return s.replace(ANSI, "");
}

/** Display order: lower first. Unknown keys go last, by key. */
const ORDER: Record<string, number> = { focus: 0, "ops-mode": 1, "rig-autofresh": 2, "rig-context": 3 };

function seatRows(list: string, paused: boolean): StatusRow[] {
	const rows = list
		.split(", ")
		.filter((e) => e.length > 0)
		.map((entry, i): StatusRow => {
			const m = /^(\S+) (\S+)(?: \((.*)\))?$/.exec(entry);
			const label = i === 0 ? "rig" : "";
			if (!m) return { label, parts: [{ text: entry, tone: "text" }] };
			const parts: Part[] = [
				{ text: m[1] ?? "", tone: "text" },
				{ text: m[2] ?? "", tone: "accent" },
			];
			if (m[3]) parts.push({ text: m[3], tone: "warning" });
			return { label, parts };
		});
	if (paused) rows.push({ label: "", parts: [{ text: "autofresh off", tone: "warning" }] });
	return rows;
}

export function statusRows(key: string, raw: string): StatusRow[] {
	const text = stripAnsi(raw).trim();
	if (!text) return [];
	switch (key) {
		case "focus": {
			const body = text.replace(/^🎯\s*/u, "");
			const [id, ...rest] = body.split(" — ");
			const parts: Part[] = [{ text: id ?? body, tone: "accent" }];
			if (rest.length) parts.push({ text: rest.join(" — "), tone: "text" });
			return [{ label: "focus", parts }];
		}
		case "ops-mode":
			return [{ label: "mode", parts: [{ text, tone: "warning" }] }];
		case "rig-autofresh": {
			const m = /^ctx( \(autofresh off\))? (.*)$/.exec(text);
			return m ? seatRows(m[2] ?? "", !!m[1]) : [{ label: "rig", parts: [{ text, tone: "text" }] }];
		}
		case "rig-context":
			return [{ label: "warn", parts: [{ text, tone: "warning" }] }];
		default:
			return [{ label: key.replace(/^rig-/, "").slice(0, 6), parts: [{ text, tone: "text" }] }];
	}
}

/** All rows for a status map, in display order. */
export function allStatusRows(statuses: ReadonlyMap<string, string>): StatusRow[] {
	return [...statuses.entries()]
		.sort(([a], [b]) => (ORDER[a] ?? 99) - (ORDER[b] ?? 99) || a.localeCompare(b))
		.flatMap(([key, text]) => statusRows(key, text));
}

import { spawnSync } from "node:child_process";

function activityTime(row) {
  const value = Date.parse(row.updated ?? "");
  return Number.isNaN(value) ? 0 : value;
}

function sortedByActivity(rows) {
  return [...rows].sort((left, right) => (
    activityTime(right) - activityTime(left)
      || left.title.localeCompare(right.title)
      || left.path.localeCompare(right.path)
  ));
}

function oneLine(value) {
  return String(value ?? "").replace(/[\t\r\n\u0000]+/g, " ");
}

export function sessionSearchText(row) {
  const fields = [
    row.title,
    row.cwd,
    row.id,
    row.model,
    ...(row.missions ?? []),
    ...(row.messages ?? []).map((message) => message.text),
  ];
  return fields.map(oneLine).filter(Boolean).join(" ");
}

function keywordQuery(query) {
  return query.replace(/(?:\\.|[^\s\\])+/g, (term) => {
    if (term === "|" || /^[!'^]/.test(term) || term.endsWith("$")) return term;
    return `'${term}`;
  });
}

export function searchSessions(rows, query, order = "recent", {
  fzfPath = "fzf",
  mode = "keywords",
  run = spawnSync,
} = {}) {
  if (order !== "recent" && order !== "relevance") {
    throw new Error(`Unknown search order: ${order}`);
  }

  if (mode !== "keywords" && mode !== "fuzzy") {
    throw new Error(`Unknown search mode: ${mode}`);
  }

  const recentRows = sortedByActivity(rows);
  if (!query) return recentRows;

  const byKey = new Map(recentRows.map((row) => [row.key, row]));
  const input = recentRows
    .map((row) => `${sessionSearchText(row)}\t${row.key}`)
    .join("\n");
  const args = [
    "--filter", mode === "keywords" ? keywordQuery(query) : query,
    "--ignore-case",
    "--delimiter", "\t",
    "--nth", "1",
    "--accept-nth", "2",
    "--sync",
    "--tiebreak", "index",
  ];
  if (order === "recent") args.push("--no-sort");

  const env = { ...process.env };
  delete env.FZF_DEFAULT_OPTS;
  delete env.FZF_DEFAULT_OPTS_FILE;
  const result = run(fzfPath, args, {
    input,
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`Could not start fzf: ${result.error.message}`, { cause: result.error });
  }
  if (result.status === 1) return [];
  if (result.status !== 0) {
    const detail = result.stderr.trim() || `exit status ${result.status}`;
    throw new Error(`fzf search failed: ${detail}`);
  }

  const matches = result.stdout
    .split("\n")
    .map((key) => key.trim())
    .filter(Boolean)
    .map((key) => byKey.get(key))
    .filter(Boolean);
  return order === "recent" ? sortedByActivity(matches) : matches;
}

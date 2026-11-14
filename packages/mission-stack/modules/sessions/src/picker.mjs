import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SessionIndex } from "./index.mjs";
import { copyResumeCommand, resumeSession, shellQuote } from "./launch.mjs";
import { formatPreview } from "./preview.mjs";
import { sanitizeText } from "./session.mjs";
import { searchSessions } from "./search.mjs";

const DEFAULT_HELPER = fileURLToPath(new URL("../bin/pi-sessions.mjs", import.meta.url));

function field(value) {
  return sanitizeText(String(value ?? "")).replace(/[\t\r\n]+/g, " ").trim();
}

function relativeActivity(value, now) {
  const then = Date.parse(value ?? "");
  if (Number.isNaN(then)) return "unknown";
  const elapsed = Math.max(0, now.getTime() - then);
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d`;
  const date = new Date(then);
  if (date.getUTCFullYear() === now.getUTCFullYear()) {
    return date.toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
  }
  return date.toISOString().slice(0, 10);
}

export function formatPickerRow(session, now = new Date()) {
  const project = field(path.basename(session.cwd || "")) || "unknown project";
  const detail = session.missions?.length ? session.missions.join(",") : session.model;
  return [
    field(session.key),
    relativeActivity(session.updated, now).padStart(7),
    project.padEnd(22).slice(0, 22),
    field(session.title),
    field(detail),
  ].join("\t");
}

export function renderPickerRows(rows, now = new Date()) {
  return rows.map((row) => formatPickerRow(row, now)).join("\n");
}

export function pickerPrompt(state) {
  const scope = state.scope === "project" ? "Current project" : "All projects";
  const order = state.order === "relevance" ? "Relevance" : "Recent";
  const mode = state.mode === "fuzzy" ? "Fuzzy" : "Keywords";
  return `${scope} · ${order} · ${mode} > `;
}

function scopedRows(state) {
  return state.rows
    .filter((row) => state.includeAgents || !row.subagent)
    .filter((row) => state.scope !== "project" || path.resolve(row.cwd) === path.resolve(state.projectPath));
}

export async function loadPickerState(statePath) {
  return JSON.parse(await readFile(statePath, "utf8"));
}

export async function savePickerState(statePath, state) {
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, statePath);
  await chmod(statePath, 0o600);
}

export async function pickerRows(statePath, query = "") {
  const state = await loadPickerState(statePath);
  const rows = searchSessions(scopedRows(state), query, state.order, { fzfPath: state.fzfPath, mode: state.mode });
  return renderPickerRows(rows);
}

export async function pickerPreview(statePath, key, query = "") {
  const state = await loadPickerState(statePath);
  return formatPreview(state.rows.find((row) => row.key === key), query);
}

export async function togglePickerState(statePath, property) {
  const state = await loadPickerState(statePath);
  if (property === "order") state.order = state.order === "recent" ? "relevance" : "recent";
  else if (property === "scope") state.scope = state.scope === "all" ? "project" : "all";
  else if (property === "mode") state.mode = state.mode === "fuzzy" ? "keywords" : "fuzzy";
  else throw new Error(`Unknown picker toggle: ${property}`);
  await savePickerState(statePath, state);
  return pickerPrompt(state);
}

export async function refreshPickerState(statePath) {
  const state = await loadPickerState(statePath);
  const index = new SessionIndex(state.cacheDir);
  try {
    await index.refresh(state.sessionRoot);
    state.rows = index.list({ includeAgents: true });
  } finally {
    index.close();
  }
  await savePickerState(statePath, state);
}

export async function copyPickerSession(statePath, key, options = {}) {
  const state = await loadPickerState(statePath);
  const session = state.rows.find((row) => row.key === key);
  if (!session) throw new Error("Selected session is no longer indexed.");
  return copyResumeCommand(session, options);
}

function helperCommand(helperPath, statePath, operation, placeholders = "") {
  const fixed = [process.execPath, helperPath, operation, statePath].map(shellQuote).join(" ");
  return placeholders ? `${fixed} ${placeholders}` : fixed;
}

function pickerArguments(statePath, state, helperPath, initialQuery) {
  const rows = helperCommand(helperPath, statePath, "--internal-rows", "{q}");
  const preview = helperCommand(helperPath, statePath, "--internal-preview", "{1} {q}");
  const prompt = helperCommand(helperPath, statePath, "--internal-prompt");
  const toggleOrder = helperCommand(helperPath, statePath, "--internal-toggle-order");
  const toggleScope = helperCommand(helperPath, statePath, "--internal-toggle-scope");
  const toggleMode = helperCommand(helperPath, statePath, "--internal-toggle-mode");
  const refresh = helperCommand(helperPath, statePath, "--internal-refresh");
  const copy = helperCommand(helperPath, statePath, "--internal-copy", "{1}");

  return [
    "--disabled",
    "--no-sort",
    "--track",
    "--delimiter", "\t",
    "--with-nth", "2..",
    "--accept-nth", "1",
    "--query", initialQuery,
    "--prompt", pickerPrompt(state),
    "--layout", "reverse",
    "--height", "90%",
    "--border", "rounded",
    "--info", "inline-right",
    "--header", "Enter resume  Ctrl-Y copy  Ctrl-P project  Ctrl-S sort  Ctrl-F mode  Ctrl-R refresh  Ctrl-/ preview",
    "--preview", preview,
    "--preview-label", "Selected session",
    "--preview-window", "right,60%,wrap,<100(down,60%,wrap)",
    "--bind", `change:reload(${rows})`,
    "--bind", `ctrl-s:execute-silent(${toggleOrder})+transform-prompt(${prompt})+reload(${rows})`,
    "--bind", `ctrl-p:execute-silent(${toggleScope})+transform-prompt(${prompt})+reload(${rows})`,
    "--bind", `ctrl-f:execute-silent(${toggleMode})+transform-prompt(${prompt})+reload(${rows})`,
    "--bind", `ctrl-r:execute-silent(${refresh})+reload(${rows})`,
    "--bind", `ctrl-y:execute-silent(${copy})`,
    "--bind", "ctrl-/:toggle-preview",
  ];
}

export async function pickSession(rows, {
  initialQuery = "",
  mode = "keywords",
  project,
  currentProject = process.cwd(),
  includeAgents = false,
  cacheDir = "",
  sessionRoot = "",
  fzfPath = "fzf",
  helperPath = DEFAULT_HELPER,
  run = spawnSync,
} = {}) {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "pi-sessions-picker-"));
  await chmod(stateDirectory, 0o700);
  const statePath = path.join(stateDirectory, "state.json");
  const state = {
    rows,
    mode,
    order: "recent",
    scope: project ? "project" : "all",
    projectPath: path.resolve(project || currentProject),
    includeAgents,
    cacheDir,
    sessionRoot,
    fzfPath,
  };
  await savePickerState(statePath, state);

  try {
    const initialRows = searchSessions(scopedRows(state), initialQuery, state.order, { fzfPath, mode });
    const env = { ...process.env };
    delete env.FZF_DEFAULT_OPTS;
    delete env.FZF_DEFAULT_OPTS_FILE;
    const result = run(fzfPath, pickerArguments(statePath, state, helperPath, initialQuery), {
      input: renderPickerRows(initialRows),
      encoding: "utf8",
      env,
      maxBuffer: 4 * 1024 * 1024,
      statePath,
    });
    if (result.error) throw new Error(`Could not start fzf: ${result.error.message}`, { cause: result.error });
    if (result.status === 1 || result.status === 130) return null;
    if (result.status !== 0) {
      throw new Error(`fzf picker failed: ${result.stderr?.trim() || `exit status ${result.status}`}`);
    }
    const key = result.stdout.trim().split("\n")[0];
    return rows.find((row) => row.key === key) ?? null;
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

export async function browseAndResume(rows, { pick = pickSession, resume = resumeSession, ...options } = {}) {
  const selected = await pick(rows, options);
  if (!selected) return null;
  await resume(selected);
  return selected;
}

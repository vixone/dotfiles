#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultCacheDir, SessionIndex } from "../src/index.mjs";
import { resumeSession } from "../src/launch.mjs";
import {
  copyPickerSession,
  loadPickerState,
  pickSession,
  pickerPreview,
  pickerPrompt,
  pickerRows,
  refreshPickerState,
  togglePickerState,
} from "../src/picker.mjs";
import { searchSessions } from "../src/search.mjs";

const EXECUTABLE = fileURLToPath(import.meta.url);

const HELP = `Usage: pi-sessions [options] [query]

Search and resume local Pi sessions across projects.

Options:
  --project [path]   Start with sessions from one project (default: cwd)
  --include-agents  Include named subagent sessions
  --fuzzy           Use fuzzy matching instead of literal keywords
  --refresh         Reparse every session before browsing
  --list            Print matching session metadata without opening fzf
  --json            Print matching session metadata as JSON
  --root path       Override the Pi sessions directory
  --cache path      Override the cache directory
  -h, --help        Show this help

Picker keys:
  Enter     Resume the selected session
  Ctrl-Y    Copy a safe resume command
  Ctrl-P    Toggle all projects and the selected project
  Ctrl-S    Toggle recent and relevance ordering
  Ctrl-F    Toggle keyword and fuzzy matching
  Ctrl-R    Refresh the session index
  Ctrl-/    Toggle the conversation preview
  Esc       Exit without resuming
`;

function defaultSessionRoot(env = process.env, home = os.homedir()) {
  if (env.PI_SESSIONS_ROOT) return env.PI_SESSIONS_ROOT;
  const agentDirectory = env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
  return path.join(agentDirectory, "sessions");
}

function parseArguments(argv) {
  const options = {
    project: null,
    includeAgents: false,
    mode: "keywords",
    refresh: false,
    list: false,
    json: false,
    help: false,
    root: defaultSessionRoot(),
    cache: process.env.PI_SESSIONS_CACHE || defaultCacheDir(),
    query: "",
  };
  const query = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      query.push(...argv.slice(index + 1));
      break;
    }
    if (argument === "-h" || argument === "--help") options.help = true;
    else if (argument === "--include-agents") options.includeAgents = true;
    else if (argument === "--fuzzy") options.mode = "fuzzy";
    else if (argument === "--refresh") options.refresh = true;
    else if (argument === "--list") options.list = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--project") {
      const candidate = argv[index + 1];
      if (candidate && !candidate.startsWith("-")) {
        options.project = path.resolve(candidate);
        index += 1;
      } else {
        options.project = process.cwd();
      }
    } else if (argument === "--root" || argument === "--cache") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`${argument} requires a path.`);
      options[argument.slice(2)] = path.resolve(value);
      index += 1;
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      query.push(argument);
    }
  }
  options.query = query.join(" ").trim();
  if (options.json) options.list = true;
  return options;
}

function publicSession(row) {
  const { messages: _messages, warnings: _warnings, ...metadata } = row;
  return { ...metadata, messageCount: row.messages.length, warningCount: row.warnings.length };
}

async function internalCommand(argv) {
  const [operation, statePath, first = "", second = ""] = argv;
  if (!operation?.startsWith("--internal-")) return false;
  if (!statePath) throw new Error(`${operation} requires picker state.`);

  if (operation === "--internal-rows") process.stdout.write(await pickerRows(statePath, first));
  else if (operation === "--internal-preview") process.stdout.write(await pickerPreview(statePath, first, second));
  else if (operation === "--internal-prompt") process.stdout.write(pickerPrompt(await loadPickerState(statePath)));
  else if (operation === "--internal-toggle-order") process.stdout.write(await togglePickerState(statePath, "order"));
  else if (operation === "--internal-toggle-scope") process.stdout.write(await togglePickerState(statePath, "scope"));
  else if (operation === "--internal-toggle-mode") process.stdout.write(await togglePickerState(statePath, "mode"));
  else if (operation === "--internal-refresh") await refreshPickerState(statePath);
  else if (operation === "--internal-copy") await copyPickerSession(statePath, first, {
    pbcopyPath: process.env.PI_SESSIONS_PBCOPY || "pbcopy",
  });
  else throw new Error(`Unknown internal operation: ${operation}`);
  return true;
}

async function main() {
  const argv = process.argv.slice(2);
  if (await internalCommand(argv)) return;

  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const index = new SessionIndex(options.cache);
  let rows;
  try {
    const refresh = await index.refresh(options.root, { force: options.refresh });
    rows = index.list({ includeAgents: options.includeAgents });
    if (refresh.warnings > 0) {
      process.stderr.write(`Skipped ${refresh.warnings} malformed session records.\n`);
    }
  } finally {
    index.close();
  }

  if (options.project) rows = rows.filter((row) => path.resolve(row.cwd) === options.project);
  if (options.list) {
    const matches = searchSessions(rows, options.query, "recent", {
      fzfPath: process.env.PI_SESSIONS_FZF || "fzf",
      mode: options.mode,
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(matches.map(publicSession), null, 2)}\n`);
    } else {
      for (const row of matches) {
        process.stdout.write(`${row.updated ?? "unknown"}\t${row.cwd}\t${row.title}\t${row.id}\n`);
      }
    }
    return;
  }

  if (rows.length === 0) {
    process.stdout.write("No Pi sessions found.\n");
    return;
  }

  const selected = await pickSession(rows, {
    initialQuery: options.query,
    mode: options.mode,
    project: options.project,
    includeAgents: true,
    cacheDir: options.cache,
    sessionRoot: options.root,
    fzfPath: process.env.PI_SESSIONS_FZF || "fzf",
    helperPath: EXECUTABLE,
  });
  if (!selected) return;
  process.exitCode = await resumeSession(selected, {
    piPath: process.env.PI_SESSIONS_PI || "pi",
  });
}

process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

main().catch((error) => {
  process.stderr.write(`pi-sessions: ${error.message}\n`);
  process.exitCode = 1;
});

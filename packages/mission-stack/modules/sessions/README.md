# pi-sessions

`pi-sessions` searches and resumes saved [Pi](https://github.com/earendil-works/pi-mono) conversations from any directory. Sessions appear by their last conversation activity, newest first. Search covers complete cleaned user and assistant text rather than a short title preview.

The tool is local and read-only. It does not change session JSONL files or send conversation data over the network.

## Requirements

- Node.js 22.13 or newer
- fzf 0.50 or newer
- Pi on `PATH` for resume actions
- macOS `pbcopy` for Ctrl-Y

There are no npm dependencies.

## Install

Part of mission-stack. The repo's `./install.sh` creates this symlink:

```text
~/.local/bin/pi-sessions -> <mission-stack>/modules/sessions/bin/pi-sessions.mjs
```

It is safe to rerun. An existing symlink is repointed; a regular file is left alone.

Make sure `~/.local/bin` is on `PATH`, then run:

```sh
pi-sessions
```

Start with a query or one project when useful:

```sh
pi-sessions envoy grafana
pi-sessions --project ~/src/my-project envoy
pi-sessions --include-agents
pi-sessions --fuzzy envoy grafana
```

## Picker controls

| Key | Action |
| --- | --- |
| Enter | Resume the selected session in its recorded working directory |
| Ctrl-Y | Copy a shell-safe resume command |
| Ctrl-P | Toggle all projects and the selected project |
| Ctrl-S | Toggle recent and relevance ordering |
| Ctrl-F | Toggle keyword and fuzzy matching |
| Ctrl-R | Refresh the session index |
| Ctrl-/ | Toggle the conversation preview |
| Esc | Exit without resuming |

The default order stays newest first while filtering. The tool sorts matched sessions by activity itself rather than relying on fzf output order. Relevance mode uses fzf match scores. The prompt shows both the ordering and the matching mode.

## Search

Search includes these fields:

- Saved Pi name or a title derived from the first useful prompt
- User and assistant text from the complete conversation
- Working directory, session ID, model, and mission IDs

Thinking blocks, tool calls, tool results, images, injected skill text, and terminal control sequences are excluded.

Search is case-insensitive and uses literal keywords by default. Every term must occur in the session, though terms can appear in different messages. This avoids scattered-letter matches across long conversations. For example, `sts:TagSession` matches that text without a leading apostrophe.

Use `--fuzzy` or Ctrl-F for scattered-letter matching. Explicit apostrophe searches stay exact in both modes. fzf extended-search syntax works in the query:

```text
envoy grafana       both literal terms by default
'envoy\ gateway     exact phrase
!subagent           exclude a term
^Resume             title prefix
kong | envoy        either term
```

Use `--list` for tab-separated metadata or `--json` for scripts. JSON output omits conversation bodies.

```sh
pi-sessions --list envoy
pi-sessions --json 01a09084
pi-sessions --list sts:TagSession
```

## Session index

The first run parses top-level JSONL files under `~/.pi/agent/sessions`. On this machine that means hundreds of files, so the first run takes longer. Later runs compare path, size, and modification time and parse only changed files. Parser revisions invalidate the cache automatically, so updated title extraction also applies to unchanged session files.

The default cache is `~/.cache/pi-sessions/sessions.sqlite`. The directory mode is 0700 and the database mode is 0600. The cache contains cleaned conversation text. It is rebuildable and safe to delete while `pi-sessions` is not running.

Force a complete reparse:

```sh
pi-sessions --refresh
```

Path overrides are available for tests or non-default Pi setups:

```sh
pi-sessions --root /path/to/sessions --cache /path/to/cache
```

The equivalent environment variables are `PI_SESSIONS_ROOT` and `PI_SESSIONS_CACHE`. When `PI_SESSIONS_ROOT` is unset, the tool honors `PI_CODING_AGENT_DIR` and appends `sessions`.

## Sessions panel

Run `/sessions` or press **Ctrl+F** in pi to open a right-anchored overlay of
recent not-closed missions and their sessions, plus a Recent tab for sessions
without a mission. `/sidebar` remains an alias. Run `/reload` after updating.

The extension lives in `extensions/sidebar`. Sessions join a mission through
`linked`: ids from `land-focus` entries and a leading `Resume mission-<id>`
heading, never prose mentions.

Ctrl+F normally moves the editor cursor right. To use it for this panel,
remove that binding in `~/.pi/agent/keybindings.json` and run `/reload`:

```json
{
  "tui.editor.cursorRight": ["right"]
}
```

Merge this entry with any existing keybindings. The right-arrow key still
moves the cursor.

| Key | Action |
|-----|--------|
| `↑` `↓` | move |
| `→` `←` / space | expand, collapse |
| `⏎` | resume (mission row = its newest session) |
| `c` | toggle closed missions |
| `esc` | close |

`●` marks the current session; `!` marks a session touched in the last two
minutes, probably open in another tab, and asks before switching.

## Titles and filtering

A saved Pi session name from `/name` or `pi --name` wins. Otherwise the tool uses a `Resume mission-... (title)` heading or the first meaningful user prompt. Leading image and PDF attachment paths are skipped when deriving a title, including quoted paths and shell-escaped spaces. The attachment paths remain searchable in the conversation. Empty sessions and names beginning with `subagent-` are hidden unless requested.

The index scans only top-level session files inside each encoded project directory. Nested artifacts and fork files are not shown as separate sessions.

## Uninstall

Remove the launcher and optional cache:

```sh
rm ~/.local/bin/pi-sessions
rm -rf ~/.cache/pi-sessions
```

The source repository and Pi session files remain untouched.

# Knowledge capture policy

Editable policy for `knowledge-capture.ts` (mission-927.11). Capture proposes a
destination and validates it; it never persists on its own. All persistence
stays a reviewed action through `mx`. The pi remember-gate checks lesson dedup.

## Destinations

New information is routed to one of:

- **environment fact** - a durable environment truth (proxy, cluster, hosting,
  delivery path). Validation is light: needs a **scope** and at least one
  **source**, not the full lesson rubric. No executable command syntax in the
  fact.
- **lesson** - a reusable cross-task rule. Must pass the non-trivial lesson
  rubric (durable phrasing: always / never / prefer / gotcha, and enough
  substance).
- **mission finding / decision / action** - only under a focused mission.
- **transient session state** - conversational or one-off; not persisted.

Environment facts are only proposed when environment knowledge is enabled;
mission capture keeps working when it is disabled.

## Updates

Updating an environment fact is a **reviewed** action keyed by identity/scope.
The plan records the previous value as history and always invalidates the index
so the changed fact is re-embedded on the next reconcile. No silent promotion of
arbitrary retrieved content into a fact.

## Corrections

User corrections are surfaced into the `/land` prompt but stay **pending** until
the landing turn actually completes. They are not consumed when the prompt is
merely dispatched, so a cancelled or interrupted landing keeps them for the next
`/land` or a resume.

## Reliable indexing

A successful `mx remember` / `/land` is indexed with **tracked retry**. On
repeated failure the outcome is `pending-reconcile` and the user is told to run
`memory-server --add-lesson <key>` or `--sync-incremental` - never an
unobserved fire-and-forget that leaves mx and the graph out of sync.

## Security boundary (read this)

- The mx CLI checks text fields on writes and refuses detected secrets (exit 3),
  including when invoked from scripts or outside pi. Its regex scan catches
  common shapes (AKIA keys, PEM blocks, `password=`, bearer tokens) and allows
  placeholders (`<REDACTED>`, `$VAR`, `...`). It can miss novel or obfuscated
  secrets; review writes yourself. Direct edits to the SQLite file bypass the
  CLI and its scan.
- The pi remember-gate checks dedup before literal `mx remember` calls and
  indexes successful lessons. Calls outside pi or from scripts do not get
  that dedup/index hook; run `memory-server --sync-incremental` after such writes.
- Never put credentials in environment facts, lessons, or mission records.

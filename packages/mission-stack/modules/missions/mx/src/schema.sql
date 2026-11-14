-- mx store schema, PROTOTYPE for mission-xbdo.13. Readers: mx (Rust, sole writer),
-- pi extensions (node:sqlite, read-only), memory-server (Go, read-only).
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
-- rows: schema_version=1, created_at, migrated_from=beads-1.2.2

CREATE TABLE issues (
  id                  TEXT PRIMARY KEY,               -- mission-xbdo, mission-xbdo.3.1
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  design              TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '',
  notes               TEXT NOT NULL DEFAULT '',       -- `mx note` appends with "\n"
  status              TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','in_progress','blocked','deferred','closed')),
  priority            INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 4),
  issue_type          TEXT NOT NULL DEFAULT 'task',   -- epic|task|bug|decision|... (free text)
  parent_id           TEXT REFERENCES issues(id) ON DELETE RESTRICT,  -- replaces parent-child deps
  assignee            TEXT,
  owner               TEXT,
  created_by          TEXT,
  created_at          TEXT NOT NULL,                  -- RFC3339 UTC
  updated_at          TEXT NOT NULL,
  started_at          TEXT,
  closed_at           TEXT,
  close_reason        TEXT,
  last_child          INTEGER NOT NULL DEFAULT 0      -- monotonic, never reused (bd semantics)
) STRICT;
CREATE INDEX issues_type_status ON issues(issue_type, status);
CREATE INDEX issues_parent      ON issues(parent_id);
CREATE INDEX issues_status      ON issues(status);

-- issue_id is blocked by / relates to depends_on.  bd: `dep add X Y` => (X, Y, 'blocks')
CREATE TABLE deps (
  issue_id   TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  depends_on TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('blocks','relates_to')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (issue_id, depends_on, type)
) STRICT, WITHOUT ROWID;
CREATE INDEX deps_target ON deps(depends_on, type);

CREATE TABLE labels (
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  label    TEXT NOT NULL,
  PRIMARY KEY (issue_id, label)
) STRICT, WITHOUT ROWID;
CREATE INDEX labels_label ON labels(label);

CREATE TABLE comments (
  id         INTEGER PRIMARY KEY,
  issue_id   TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author     TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX comments_issue ON comments(issue_id, created_at);

CREATE TABLE memories (
  key        TEXT PRIMARY KEY,                        -- slug; `remember` w/o --key derives it
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- Audit log. Append-only fields (notes) store the DELTA, not old/new snapshots
-- (beads stored full snapshots: 1,233 events = 141MB).
CREATE TABLE events (
  id         INTEGER PRIMARY KEY,
  issue_id   TEXT,                                    -- NULL for memory events; no FK so history survives delete
  memory_key TEXT,
  kind       TEXT NOT NULL,   -- created|updated|status_changed|closed|reopened|claimed|label_added|label_removed|note_appended|commented|dep_added|deleted|remembered|forgot
  field      TEXT,
  old_value  TEXT,
  new_value  TEXT,
  reason     TEXT,
  actor      TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX events_issue ON events(issue_id, created_at);

-- ready = open, unblocked by open 'blocks' deps (bd ready semantics, minus defer_until).
CREATE VIEW ready_issues AS
SELECT i.* FROM issues i
WHERE i.status = 'open'
  AND NOT EXISTS (
    SELECT 1 FROM deps d JOIN issues b ON b.id = d.depends_on
    WHERE d.issue_id = i.id AND d.type = 'blocks' AND b.status <> 'closed');

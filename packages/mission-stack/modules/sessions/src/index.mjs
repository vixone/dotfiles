import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { parseSession, SESSION_PARSER_VERSION } from "./session.mjs";

function sessionKey(sessionPath) {
  return createHash("sha256").update(sessionPath).digest("hex");
}

function activityTime(row) {
  const value = Date.parse(row.updated ?? "");
  return Number.isNaN(value) ? 0 : value;
}

function newestFirst(left, right) {
  return activityTime(right) - activityTime(left)
    || left.title.localeCompare(right.title)
    || left.path.localeCompare(right.path);
}

async function topLevelSessionFiles(root) {
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = path.join(root, project.name);
    let entries;
    try {
      entries = await readdir(projectPath, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(path.join(projectPath, entry.name));
      }
    }
  }
  return files.sort();
}

export function defaultCacheDir(env = process.env, home = os.homedir()) {
  const base = env.XDG_CACHE_HOME || path.join(home, ".cache");
  return path.join(base, "pi-sessions");
}

export class SessionIndex {
  constructor(cacheDir = defaultCacheDir()) {
    this.cacheDir = path.resolve(cacheDir);
    this.databasePath = path.join(this.cacheDir, "sessions.sqlite");
    this.database = null;
  }

  async open() {
    if (this.database) return;
    await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    await chmod(this.cacheDir, 0o700);
    this.database = new DatabaseSync(this.databasePath);
    await chmod(this.databasePath, 0o600);
    this.database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS sessions (
        key TEXT PRIMARY KEY,
        root TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_root ON sessions(root);
    `);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const revision = this.database.prepare("PRAGMA user_version").get().user_version;
      if (revision !== SESSION_PARSER_VERSION) {
        this.database.exec(`DELETE FROM sessions; PRAGMA user_version = ${SESSION_PARSER_VERSION};`);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async refresh(sessionRoot, { force = false } = {}) {
    await this.open();
    const root = path.resolve(sessionRoot);
    const files = await topLevelSessionFiles(root);
    const knownRows = this.database
      .prepare("SELECT path, size, mtime_ms FROM sessions WHERE root = ?")
      .all(root);
    const known = new Map(knownRows.map((row) => [row.path, row]));
    const changed = [];
    let unchanged = 0;

    for (const sessionPath of files) {
      let details;
      try {
        details = await stat(sessionPath);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      const cached = known.get(sessionPath);
      if (!force && cached && cached.size === details.size && cached.mtime_ms === details.mtimeMs) {
        unchanged += 1;
      } else {
        changed.push({ path: sessionPath, size: details.size, mtimeMs: details.mtimeMs });
      }
    }

    const parsed = [];
    let warningCount = 0;
    for (const file of changed) {
      try {
        const text = await readFile(file.path, "utf8");
        const session = parseSession(text, file.path);
        warningCount += session.warnings.length;
        parsed.push({ ...file, session });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }

    const present = new Set(files);
    const removed = knownRows.filter((row) => !present.has(row.path));
    const upsert = this.database.prepare(`
      INSERT INTO sessions (key, root, path, size, mtime_ms, data)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        root = excluded.root,
        path = excluded.path,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        data = excluded.data
    `);
    const remove = this.database.prepare("DELETE FROM sessions WHERE root = ? AND path = ?");

    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const item of parsed) {
        upsert.run(
          sessionKey(item.path),
          root,
          item.path,
          item.size,
          item.mtimeMs,
          JSON.stringify(item.session),
        );
      }
      for (const item of removed) remove.run(root, item.path);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    return {
      discovered: files.length,
      parsed: parsed.length,
      unchanged,
      removed: removed.length,
      warnings: warningCount,
    };
  }

  list({ project, includeAgents = false } = {}) {
    if (!this.database) throw new Error("Session index is not open. Call refresh() first.");
    const requestedProject = project ? path.resolve(project) : null;
    return this.database
      .prepare("SELECT key, data FROM sessions")
      .all()
      .map((row) => ({ key: row.key, ...JSON.parse(row.data) }))
      .filter((row) => row.messages.length > 0)
      .filter((row) => includeAgents || !row.subagent)
      .filter((row) => !requestedProject || (row.cwd && path.resolve(row.cwd) === requestedProject))
      .sort(newestFirst);
  }

  get(key) {
    if (!this.database) throw new Error("Session index is not open. Call refresh() first.");
    const row = this.database.prepare("SELECT key, data FROM sessions WHERE key = ?").get(key);
    return row ? { key: row.key, ...JSON.parse(row.data) } : null;
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}

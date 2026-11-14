//! SQLite store. mx is the only writer; pi extensions and memory-server read
//! the same file. WAL lets readers run while a write is in flight.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};

/// Schema version this binary writes and understands.
pub const SCHEMA_VERSION: i64 = 1;

const SCHEMA_SQL: &str = include_str!("schema.sql");

pub struct Store {
    conn: Connection,
    path: PathBuf,
}

/// `MX_DB` if set and non-empty, else `~/.missions/mx.db`.
pub fn default_path() -> Result<PathBuf> {
    if let Some(p) = std::env::var_os("MX_DB").filter(|p| !p.is_empty()) {
        return Ok(PathBuf::from(p));
    }
    let home = std::env::var_os("HOME").context("HOME is not set and MX_DB is empty")?;
    Ok(PathBuf::from(home).join(".missions").join("mx.db"))
}

impl Store {
    /// Open (and on first use create) the store at `path`.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir)
                .with_context(|| format!("create {}", dir.display()))?;
        }
        let conn = Connection::open(path).with_context(|| format!("open {}", path.display()))?;
        conn.busy_timeout(Duration::from_millis(5000))?;
        let mode: String = conn.query_row("pragma journal_mode = WAL", [], |r| r.get(0))?;
        if !mode.eq_ignore_ascii_case("wal") {
            bail!("{}: could not enable WAL (journal_mode={mode})", path.display());
        }
        conn.pragma_update(None, "foreign_keys", "ON")?;

        let mut store = Store { conn, path: path.to_path_buf() };
        store.migrate().with_context(|| format!("{}", path.display()))?;
        Ok(store)
    }

    /// Open the store at [`default_path`].
    pub fn open_default() -> Result<Self> {
        Self::open(&default_path()?)
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// `MX_BACKUP_DIR`, else `backup/` next to the db file.
    pub fn backup_dir(&self) -> PathBuf {
        if let Some(p) = std::env::var_os("MX_BACKUP_DIR").filter(|p| !p.is_empty()) {
            return PathBuf::from(p);
        }
        self.path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("backup")
    }

    /// Run `f` inside `BEGIN IMMEDIATE`. Commits on Ok, rolls back on Err.
    /// The first committed write of each UTC day also takes a snapshot.
    pub fn write<T>(&mut self, f: impl FnOnce(&Transaction) -> Result<T>) -> Result<T> {
        let out = self.write_no_backup(f)?;
        crate::backup::after_write(self);
        Ok(out)
    }

    /// [`Store::write`] without the daily snapshot (schema setup, import).
    pub fn write_no_backup<T>(&mut self, f: impl FnOnce(&Transaction) -> Result<T>) -> Result<T> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }

    fn migrate(&mut self) -> Result<()> {
        if let Some(v) = schema_version(&self.conn)? {
            return check_version(v);
        }
        self.write_no_backup(|tx| {
            // Re-check under the write lock: another mx may have won the race.
            if let Some(v) = schema_version(tx)? {
                return check_version(v);
            }
            tx.execute_batch(SCHEMA_SQL).context("apply schema v1")?;
            tx.execute(
                "insert into meta(key, value) values ('schema_version', ?1), ('created_at', ?2)",
                (SCHEMA_VERSION.to_string(), now_rfc3339()),
            )?;
            Ok(())
        })
    }
}

fn schema_version(conn: &Connection) -> Result<Option<i64>> {
    let has_meta: bool = conn.query_row(
        "select exists(select 1 from sqlite_master where type='table' and name='meta')",
        [],
        |r| r.get(0),
    )?;
    if !has_meta {
        return Ok(None);
    }
    let raw: Option<String> = conn
        .query_row("select value from meta where key='schema_version'", [], |r| r.get(0))
        .optional()?;
    let raw = raw.context("meta table has no schema_version row")?;
    let v = raw
        .parse::<i64>()
        .with_context(|| format!("schema_version {raw:?} is not an integer"))?;
    Ok(Some(v))
}

fn check_version(v: i64) -> Result<()> {
    if v > SCHEMA_VERSION {
        bail!("store has schema_version {v}, this mx supports up to {SCHEMA_VERSION}; upgrade mx");
    }
    Ok(())
}

/// Current time as RFC3339 UTC with second precision, e.g. 2026-10-30T12:03:00Z.
pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

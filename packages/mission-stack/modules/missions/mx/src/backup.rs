//! Daily snapshot: the first committed write of each UTC day runs
//! `VACUUM INTO <backup_dir>/mx-YYYYMMDD.db` and keeps the newest 14.
//! A failed backup warns on stderr and never fails the write.

use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use rusqlite::OptionalExtension;

use crate::store::Store;

pub const KEEP: usize = 14;

pub fn after_write(store: &Store) {
    if let Err(e) = snapshot_if_due(store) {
        eprintln!("Warning: daily backup failed: {e:#}");
    }
}

fn is_snapshot(name: &str) -> bool {
    name.len() == "mx-YYYYMMDD.db".len()
        && name.starts_with("mx-")
        && name.ends_with(".db")
        && name[3..11].bytes().all(|b| b.is_ascii_digit())
}

fn snapshot_if_due(store: &Store) -> Result<()> {
    let conn = store.conn();
    let today = chrono::Utc::now().format("%Y%m%d").to_string();
    let last: Option<String> = conn
        .query_row("select value from meta where key='last_backup_date'", [], |r| r.get(0))
        .optional()?;
    if last.as_deref() == Some(today.as_str()) {
        return Ok(());
    }
    let dir = store.backup_dir();
    snapshot(store, &dir, &today)?;
    conn.execute(
        "insert into meta(key, value) values ('last_backup_date', ?1)
         on conflict(key) do update set value=excluded.value",
        [&today],
    )?;
    prune(&dir, KEEP)
}

/// `VACUUM INTO` the dated file. Replace an existing snapshot atomically if
/// this store needs a new one (for example after an import on the same day).
pub fn snapshot(store: &Store, dir: &Path, day: &str) -> Result<()> {
    fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    let target = dir.join(format!("mx-{day}.db"));
    let path = if target.exists() {
        dir.join(format!(".mx-{day}-{}-{}.tmp", std::process::id(), rand::random::<u64>()))
    } else {
        target.clone()
    };
    let path_str = path.to_str().context("backup path is not UTF-8")?;
    let result = (|| {
        store
            .conn()
            .execute("vacuum into ?1", [path_str])
            .with_context(|| format!("vacuum into {}", path.display()))?;
        if path != target {
            fs::rename(&path, &target).with_context(|| format!("replace {}", target.display()))?;
        }
        Ok(())
    })();
    if result.is_err() && path != target {
        let _ = fs::remove_file(&path);
    }
    result
}

/// Keep the `keep` newest mx-YYYYMMDD.db files; leave anything else alone.
pub fn prune(dir: &Path, keep: usize) -> Result<()> {
    let mut snaps: Vec<String> = fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| is_snapshot(n))
        .collect();
    snaps.sort_unstable_by(|a, b| b.cmp(a));
    for old in snaps.into_iter().skip(keep) {
        fs::remove_file(dir.join(&old)).with_context(|| format!("remove {old}"))?;
    }
    Ok(())
}

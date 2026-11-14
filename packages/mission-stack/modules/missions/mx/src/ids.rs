//! Issue ids. Top-level: `<prefix>-` + 4 random base36 chars. Children:
//! `<parent>.<n>` with n = parent.last_child + 1, never reused.

use anyhow::{bail, Result};
use rand::Rng;
use rusqlite::{Connection, OptionalExtension};

const BASE36: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
const DEFAULT_PREFIX: &str = "mission";

pub fn prefix(conn: &Connection) -> Result<String> {
    let p: Option<String> = conn
        .query_row("select value from meta where key='id_prefix'", [], |r| r.get(0))
        .optional()?;
    Ok(p.unwrap_or_else(|| DEFAULT_PREFIX.to_string()))
}

/// True if `id` is or ever was an issue (deleted ids live on in events).
fn taken(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn.query_row(
        "select exists(select 1 from issues where id=?1) or exists(select 1 from events where issue_id=?1)",
        [id],
        |r| r.get(0),
    )?)
}

pub fn new_top_id(conn: &Connection) -> Result<String> {
    let prefix = prefix(conn)?;
    let mut rng = rand::thread_rng();
    for _ in 0..64 {
        let suffix: String = (0..4)
            .map(|_| BASE36[rng.gen_range(0..BASE36.len())] as char)
            .collect();
        let id = format!("{prefix}-{suffix}");
        if !taken(conn, &id)? {
            return Ok(id);
        }
    }
    bail!("could not find a free {prefix}-xxxx id after 64 tries")
}

/// Bump `parent.last_child` and return the new child id. Call inside the
/// write transaction that inserts the child.
pub fn next_child_id(conn: &Connection, parent: &str) -> Result<String> {
    loop {
        let n: i64 = conn.query_row(
            "update issues set last_child = last_child + 1 where id=?1 returning last_child",
            [parent],
            |r| r.get(0),
        )?;
        let id = format!("{parent}.{n}");
        // An imported store may hold children the counter does not know about.
        if !taken(conn, &id)? {
            return Ok(id);
        }
    }
}

//! close and reopen. A batch is ordered topologically (blockers before the
//! issues they block, children before parents) and evaluated in one
//! transaction, so each check sees the closes made earlier in the batch.
//! Refusals do not roll back the rest, but make the exit code 1.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use anyhow::Result;
use clap::Args;
use rusqlite::Connection;
use serde_json::Value;

use crate::error;
use crate::events::{Actor, Event};
use crate::issue::{self, Issue};
use crate::secrets;
use crate::store::{now_rfc3339, Store};

pub const DEFAULT_REASON: &str = "Closed";

#[derive(Args)]
pub struct CloseArgs {
    #[arg(required = true)]
    pub ids: Vec<String>,
    /// Reason; give once for all ids or once per id (positional).
    #[arg(short = 'r', long)]
    pub reason: Vec<String>,
    /// Read the reason from a file (- for stdin).
    #[arg(long, value_name = "FILE")]
    pub reason_file: Option<String>,
    /// Close even with open children or open blockers.
    #[arg(short = 'f', long)]
    pub force: bool,
}

#[derive(Args)]
pub struct ReopenArgs {
    #[arg(required = true)]
    pub ids: Vec<String>,
    #[arg(short = 'r', long)]
    pub reason: Option<String>,
}

fn open_blockers(conn: &Connection, id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare_cached(
        "select d.depends_on from deps d join issues b on b.id = d.depends_on
         where d.issue_id=?1 and d.type='blocks' and b.status <> 'closed'
         order by d.depends_on",
    )?;
    let rows = stmt.query_map([id], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn open_children(conn: &Connection, id: &str) -> Result<i64> {
    Ok(conn.query_row(
        "select count(*) from issues where parent_id=?1 and status <> 'closed'",
        [id],
        |r| r.get(0),
    )?)
}

/// Why `issue` cannot be closed right now, if anything.
pub(crate) fn refusal(conn: &Connection, issue: &Issue, force: bool) -> Result<Option<String>> {
    if force {
        return Ok(None);
    }
    let n = open_children(conn, &issue.id)?;
    if n > 0 {
        let kind = if issue.issue_type == "epic" { "epic" } else { "issue" };
        return Ok(Some(format!(
            "cannot close {kind} {}: {n} open child issue(s); close children first or use --force",
            issue.id
        )));
    }
    let blockers = open_blockers(conn, &issue.id)?;
    if !blockers.is_empty() {
        return Ok(Some(format!(
            "cannot close {}: blocked by open issues [{}]",
            issue.id,
            blockers.join(", ")
        )));
    }
    Ok(None)
}

/// Mark `issue` closed and log it. Callers run [`refusal`] first.
pub(crate) fn close_issue(
    conn: &Connection,
    actor: &Actor,
    now: &str,
    issue: &Issue,
    reason: &str,
) -> Result<()> {
    conn.execute(
        "update issues set status='closed', closed_at=?1, close_reason=?2, updated_at=?1 where id=?3",
        (now, reason, &issue.id),
    )?;
    Event::issue(&issue.id, "closed")
        .field("status")
        .old(Some(&issue.status))
        .new(Some("closed"))
        .reason(Some(reason))
        .log(conn, actor, now)
}

/// Kahn's algorithm over the batch; ties and cycles keep the input order.
fn topo_order(conn: &Connection, batch: &[String]) -> Result<Vec<String>> {
    let in_batch: BTreeSet<&str> = batch.iter().map(String::as_str).collect();
    let pos: HashMap<&str, usize> = batch.iter().enumerate().map(|(i, s)| (s.as_str(), i)).collect();
    // before[x] = ids in the batch that must close before x.
    let mut before: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for id in batch {
        before.entry(id).or_default();
        let Some(issue) = issue::get(conn, id)? else { continue };
        for b in open_blockers(conn, id)? {
            if let Some(&b) = in_batch.get(b.as_str()) {
                before.entry(id.as_str()).or_default().insert(b);
            }
        }
        if let Some(&p) = issue.parent_id.as_deref().and_then(|p| in_batch.get(p)) {
            before.entry(p).or_default().insert(id.as_str());
        }
    }
    let mut order = Vec::with_capacity(batch.len());
    let mut done: BTreeSet<&str> = BTreeSet::new();
    while order.len() < batch.len() {
        let mut ready: Vec<&str> = before
            .iter()
            .filter(|(id, deps)| !done.contains(*id) && deps.iter().all(|d| done.contains(d)))
            .map(|(id, _)| *id)
            .collect();
        if ready.is_empty() {
            // Cycle: fall back to input order for whatever is left.
            ready = batch.iter().map(String::as_str).filter(|id| !done.contains(id)).collect();
        }
        ready.sort_by_key(|id| pos[id]);
        for id in ready {
            done.insert(id);
            order.push(id.to_string());
        }
    }
    Ok(order)
}

fn reasons_for(a: &CloseArgs, ids: &[String]) -> Result<HashMap<String, String>> {
    let mut reasons = a.reason.clone();
    if let Some(f) = &a.reason_file {
        let text = if f == "-" {
            std::io::read_to_string(std::io::stdin())?
        } else {
            std::fs::read_to_string(f)?
        };
        reasons.push(text.trim().to_string());
    }
    let out = match reasons.len() {
        0 => ids.iter().map(|id| (id.clone(), DEFAULT_REASON.to_string())).collect(),
        1 => ids.iter().map(|id| (id.clone(), reasons[0].clone())).collect(),
        n if n == ids.len() => ids.iter().cloned().zip(reasons).collect(),
        n => {
            return Err(error::usage(format!(
                "{n} reasons for {} ids: give one reason, or one per id",
                ids.len()
            )))
        }
    };
    Ok(out)
}

fn dedupe(ids: &[String]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    ids.iter().filter(|id| seen.insert(id.as_str())).cloned().collect()
}

fn print_rows(conn: &Connection, ids: &[String]) -> Result<()> {
    let rows = ids
        .iter()
        .map(|id| issue::json(conn, id).map(Value::Object))
        .collect::<Result<Vec<_>>>()?;
    println!("{}", serde_json::to_string_pretty(&Value::Array(rows))?);
    Ok(())
}

fn finish(refused: &[String], total: usize) -> Result<()> {
    for msg in refused {
        eprintln!("Error: {msg}");
    }
    if refused.is_empty() {
        Ok(())
    } else {
        Err(error::invalid(format!("{} of {total} issue(s) refused", refused.len())))
    }
}

pub fn close(store: &mut Store, a: CloseArgs, json_out: bool) -> Result<()> {
    let batch = dedupe(&a.ids);
    let reasons = reasons_for(&a, &batch)?;
    let texts: Vec<(&str, &str)> = reasons.values().map(|r| ("reason", r.as_str())).collect();
    secrets::check(&texts)?;

    let actor = Actor::resolve();
    let now = now_rfc3339();
    let (closed, already, refused) = store.write(|tx| {
        let (mut closed, mut already, mut refused) = (Vec::new(), Vec::new(), Vec::new());
        for id in topo_order(tx, &batch)? {
            let Some(issue) = issue::get(tx, &id)? else {
                refused.push(format!("issue {id} not found"));
                continue;
            };
            if issue.status == "closed" {
                already.push(id);
                continue;
            }
            if let Some(msg) = refusal(tx, &issue, a.force)? {
                refused.push(msg);
                continue;
            }
            close_issue(tx, &actor, &now, &issue, &reasons[&id])?;
            closed.push(id);
        }
        Ok((closed, already, refused))
    })?;

    if json_out {
        print_rows(store.conn(), &closed)?;
    } else {
        for id in &closed {
            println!("✓ Closed {id}: {}", reasons[id]);
        }
        for id in &already {
            println!("• {id} is already closed");
        }
    }
    finish(&refused, batch.len())
}

pub fn reopen(store: &mut Store, a: ReopenArgs, json_out: bool) -> Result<()> {
    let batch = dedupe(&a.ids);
    if let Some(r) = &a.reason {
        secrets::check(&[("reason", r)])?;
    }
    let actor = Actor::resolve();
    let now = now_rfc3339();
    let (reopened, refused) = store.write(|tx| {
        let (mut reopened, mut refused) = (Vec::new(), Vec::new());
        for id in &batch {
            let Some(issue) = issue::get(tx, id)? else {
                refused.push(format!("issue {id} not found"));
                continue;
            };
            if issue.status != "closed" {
                refused.push(format!("cannot reopen {id}: status is {}", issue.status));
                continue;
            }
            tx.execute(
                "update issues set status='open', closed_at=NULL, close_reason=NULL, updated_at=?1 where id=?2",
                (&now, id),
            )?;
            Event::issue(id, "reopened")
                .field("status")
                .old(Some("closed"))
                .new(Some("open"))
                .reason(a.reason.as_deref())
                .log(tx, &actor, &now)?;
            reopened.push(id.clone());
        }
        Ok((reopened, refused))
    })?;

    if json_out {
        print_rows(store.conn(), &reopened)?;
    } else {
        for id in &reopened {
            println!("✓ Reopened {id}");
        }
    }
    finish(&refused, batch.len())
}

//! The one place that turns issues into bd-shaped JSON for read commands.
//! Enrichment (labels, edges, counts) is loaded in bulk with json_each so a
//! 2,600-row `list --all` costs a handful of queries, not thousands.

use std::collections::HashMap;

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use crate::issue::{self, Issue};

struct Edge {
    depends_on: String,
    ty: String,
    created_at: String,
}

#[derive(Default)]
struct Extra {
    labels: HashMap<String, Vec<String>>,
    edges: HashMap<String, Vec<Edge>>,
    dependents: HashMap<String, i64>,
    comments: HashMap<String, i64>,
}

fn id_array(issues: &[Issue]) -> String {
    Value::Array(issues.iter().map(|i| json!(i.id)).collect()).to_string()
}

fn load_extra(conn: &Connection, issues: &[Issue]) -> Result<Extra> {
    let ids = id_array(issues);
    let mut x = Extra::default();

    let mut stmt = conn.prepare_cached(
        "select issue_id, label from labels where issue_id in (select value from json_each(?1))
         order by issue_id, label",
    )?;
    let mut rows = stmt.query([&ids])?;
    while let Some(r) = rows.next()? {
        x.labels.entry(r.get(0)?).or_default().push(r.get(1)?);
    }

    let mut stmt = conn.prepare_cached(
        "select issue_id, depends_on, type, created_at from deps
         where issue_id in (select value from json_each(?1)) order by issue_id, depends_on, type",
    )?;
    let mut rows = stmt.query([&ids])?;
    while let Some(r) = rows.next()? {
        x.edges.entry(r.get(0)?).or_default().push(Edge {
            depends_on: r.get(1)?,
            ty: r.get(2)?,
            created_at: r.get(3)?,
        });
    }

    // Dependents: issues that depend on this one, plus its children
    // (bd stores parent-child as a dependency edge).
    let mut stmt = conn.prepare_cached(
        "select id, count(*) from (
             select depends_on as id from deps where depends_on in (select value from json_each(?1))
             union all
             select parent_id from issues where parent_id in (select value from json_each(?1)))
         group by id",
    )?;
    let mut rows = stmt.query([&ids])?;
    while let Some(r) = rows.next()? {
        x.dependents.insert(r.get(0)?, r.get(1)?);
    }

    let mut stmt = conn.prepare_cached(
        "select issue_id, count(*) from comments where issue_id in (select value from json_each(?1))
         group by issue_id",
    )?;
    let mut rows = stmt.query([&ids])?;
    while let Some(r) = rows.next()? {
        x.comments.insert(r.get(0)?, r.get(1)?);
    }
    Ok(x)
}

fn row(i: &Issue, x: &Extra) -> Map<String, Value> {
    let empty = Vec::new();
    let labels = x.labels.get(&i.id).unwrap_or(&empty);
    let mut m = i.to_json(labels);
    let mut deps = Vec::new();
    if let Some(p) = &i.parent_id {
        deps.push(json!({
            "issue_id": i.id, "depends_on_id": p, "type": "parent-child", "created_at": i.created_at,
        }));
    }
    for e in x.edges.get(&i.id).into_iter().flatten() {
        deps.push(json!({
            "issue_id": i.id, "depends_on_id": e.depends_on, "type": e.ty, "created_at": e.created_at,
        }));
    }
    let dependency_count = deps.len();
    if !deps.is_empty() {
        m.insert("dependencies".into(), Value::Array(deps));
    }
    m.insert("dependency_count".into(), json!(dependency_count));
    m.insert("dependent_count".into(), json!(x.dependents.get(&i.id).copied().unwrap_or(0)));
    m.insert("comment_count".into(), json!(x.comments.get(&i.id).copied().unwrap_or(0)));
    if let Some(p) = &i.parent_id {
        m.insert("parent".into(), json!(p));
    }
    m
}

/// List-style rows (list, ready, search, children).
pub fn rows(conn: &Connection, issues: &[Issue]) -> Result<Value> {
    if issues.is_empty() {
        return Ok(Value::Array(Vec::new()));
    }
    let x = load_extra(conn, issues)?;
    Ok(Value::Array(issues.iter().map(|i| Value::Object(row(i, &x))).collect()))
}

/// Export object: a list row (labels, dependency edges, counts, parent)
/// plus comments. Edges, not expanded issues: expanding repeats the
/// parent's notes in every child and grows the dump by orders of magnitude.
pub fn export_rows(conn: &Connection, issues: &[Issue]) -> Result<Vec<Map<String, Value>>> {
    if issues.is_empty() {
        return Ok(Vec::new());
    }
    let x = load_extra(conn, issues)?;
    issues
        .iter()
        .map(|i| {
            let mut m = row(i, &x);
            m.insert("comments".into(), Value::Array(comments(conn, &i.id)?));
            Ok(m)
        })
        .collect()
}

/// `show` object: list row fields, with dependencies expanded to full issue
/// objects by default. Compact mode reads only dependency identity and display
/// fields, avoiding large notes on a parent epic. Comments are opt-in.
pub fn show(conn: &Connection, i: &Issue, include_comments: bool, compact_deps: bool) -> Result<Map<String, Value>> {
    let x = load_extra(conn, std::slice::from_ref(i))?;
    let base = row(i, &x);
    let mut m = i.to_json(x.labels.get(&i.id).map(Vec::as_slice).unwrap_or(&[]));

    let mut deps = Vec::new();
    let mut targets: Vec<(String, String)> = Vec::new();
    if let Some(p) = &i.parent_id {
        targets.push((p.clone(), "parent-child".into()));
    }
    for e in x.edges.get(&i.id).into_iter().flatten() {
        targets.push((e.depends_on.clone(), e.ty.clone()));
    }
    for (id, ty) in targets {
        if compact_deps {
            let mut stmt = conn.prepare_cached("select id, title, status, priority from issues where id=?1")?;
            let dep: Option<(String, String, String, i64)> = stmt
                .query_row([&id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                .optional()?;
            if let Some((id, title, status, priority)) = dep {
                deps.push(json!({
                    "id": id, "title": title, "status": status, "priority": priority,
                    "dependency_type": ty,
                }));
            }
        } else if let Some(d) = issue::get(conn, &id)? {
            let mut o = d.to_json(&[]);
            o.insert("dependency_type".into(), json!(ty));
            deps.push(Value::Object(o));
        }
    }
    if !deps.is_empty() {
        m.insert("dependencies".into(), Value::Array(deps));
    }
    if include_comments {
        m.insert("comments".into(), Value::Array(comments(conn, &i.id)?));
    }
    for k in ["parent", "dependent_count", "dependency_count", "comment_count"] {
        if let Some(v) = base.get(k) {
            m.insert(k.into(), v.clone());
        }
    }
    Ok(m)
}

pub fn comments(conn: &Connection, id: &str) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare_cached(
        "select id, author, text, created_at from comments where issue_id=?1 order by created_at, id",
    )?;
    let rows = stmt.query_map([id], |r| {
        Ok(json!({
            "id": r.get::<_, i64>(0)?,
            "issue_id": id,
            "author": r.get::<_, String>(1)?,
            "text": r.get::<_, String>(2)?,
            "created_at": r.get::<_, String>(3)?,
        }))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

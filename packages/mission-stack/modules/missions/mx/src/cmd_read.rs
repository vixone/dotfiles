//! Read commands: list, show, children, ready, search, history. Reads never
//! open a write transaction.

use anyhow::Result;
use clap::Args;
use rusqlite::{types::Value as Sql, Connection};
use serde_json::{json, Map, Value};

use crate::error;
use crate::issue::{self, Issue, COLUMNS};
use crate::json;
use crate::store::Store;

// ---------------------------------------------------------------- filters

#[derive(Default)]
struct Filter {
    /// None = any status.
    statuses: Option<Vec<String>>,
    issue_type: Option<String>,
    labels: Vec<String>,
    parent: Option<String>,
    descendants_of: Option<String>,
    unassigned: bool,
    text: Option<String>,
}

enum Order {
    PriorityUpdated,
    PriorityCreated,
}

fn query(conn: &Connection, from: &str, f: &Filter, order: Order, limit: i64) -> Result<Vec<Issue>> {
    let mut sql = format!("select {COLUMNS} from {from} i where 1=1");
    let mut params: Vec<Sql> = Vec::new();
    let mut bind = |sql: &mut String, frag: &str, v: &str| {
        params.push(Sql::Text(v.to_string()));
        sql.push_str(&frag.replace('?', &format!("?{}", params.len())));
    };
    if let Some(st) = &f.statuses {
        let arr = Value::Array(st.iter().map(|s| json!(s)).collect()).to_string();
        bind(&mut sql, " and status in (select value from json_each(?))", &arr);
    }
    if let Some(t) = &f.issue_type {
        bind(&mut sql, " and issue_type = ?", t);
    }
    for l in &f.labels {
        bind(&mut sql, " and exists(select 1 from labels l where l.issue_id = i.id and l.label = ?)", l);
    }
    if let Some(p) = &f.parent {
        bind(&mut sql, " and parent_id = ?", p);
    }
    if let Some(p) = &f.descendants_of {
        bind(
            &mut sql,
            " and id in (with recursive d(id) as (select id from issues where parent_id = ? \
              union all select x.id from issues x join d on x.parent_id = d.id) select id from d)",
            p,
        );
    }
    if f.unassigned {
        sql.push_str(" and (assignee is null or assignee = '')");
    }
    if let Some(q) = &f.text {
        bind(
            &mut sql,
            " and (instr(lower(title), lower(?)) > 0 or instr(lower(id), lower(?)) > 0)",
            q,
        );
    }
    sql.push_str(match order {
        Order::PriorityUpdated => " order by priority, updated_at desc, id",
        Order::PriorityCreated => " order by priority, created_at desc, id",
    });
    if limit > 0 {
        sql.push_str(&format!(" limit {limit}"));
    }
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(params), Issue::from_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// `open,in_progress` -> Some([..]); `all` -> None; no flag -> `default`.
fn parse_statuses(raw: Option<&str>, all: bool, default: Option<Vec<String>>) -> Result<Option<Vec<String>>> {
    if all {
        return Ok(None);
    }
    let Some(raw) = raw else { return Ok(default) };
    if raw.trim().eq_ignore_ascii_case("all") {
        return Ok(None);
    }
    let parts = raw
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(issue::parse_status)
        .collect::<Result<Vec<_>>>()?;
    Ok(Some(parts))
}

fn not_closed() -> Option<Vec<String>> {
    Some(
        issue::STATUSES
            .iter()
            .filter(|s| **s != "closed")
            .map(|s| s.to_string())
            .collect(),
    )
}

fn split(raw: &[String]) -> Vec<String> {
    raw.iter()
        .flat_map(|s| s.split(','))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

fn emit(conn: &Connection, issues: &[Issue], json_out: bool) -> Result<()> {
    if json_out {
        println!("{}", serde_json::to_string_pretty(&json::rows(conn, issues)?)?);
    } else {
        for i in issues {
            println!("{} [{}] {}", i.id, i.status, i.title);
        }
    }
    Ok(())
}

// ------------------------------------------------------------------- list

#[derive(Args)]
pub struct ListArgs {
    /// Status filter, comma-separated (default: everything but closed).
    #[arg(short = 's', long)]
    pub status: Option<String>,
    /// Include closed issues.
    #[arg(long)]
    pub all: bool,
    #[arg(short = 't', long = "type")]
    pub issue_type: Option<String>,
    /// Must carry every given label.
    #[arg(short = 'l', long, value_delimiter = ',')]
    pub label: Vec<String>,
    /// Direct children of this issue.
    #[arg(long)]
    pub parent: Option<String>,
    /// Max rows, 0 = unlimited (default: unlimited with --json, else 50).
    #[arg(short = 'n', long)]
    pub limit: Option<i64>,
}

pub fn list(store: &Store, a: ListArgs, json_out: bool) -> Result<()> {
    let f = Filter {
        statuses: parse_statuses(a.status.as_deref(), a.all, not_closed())?,
        issue_type: a.issue_type.as_deref().map(issue::normalize_type),
        labels: split(&a.label),
        parent: a.parent,
        ..Default::default()
    };
    let limit = a.limit.unwrap_or(if json_out { 0 } else { 50 });
    let rows = query(store.conn(), "issues", &f, Order::PriorityUpdated, limit)?;
    emit(store.conn(), &rows, json_out)
}

// ------------------------------------------------------------------ ready

#[derive(Args)]
pub struct ReadyArgs {
    /// Only descendants of this issue (any depth).
    #[arg(long)]
    pub parent: Option<String>,
    #[arg(short = 'l', long, value_delimiter = ',')]
    pub label: Vec<String>,
    #[arg(short = 't', long = "type")]
    pub issue_type: Option<String>,
    #[arg(short = 'u', long)]
    pub unassigned: bool,
    /// Max rows, 0 = unlimited.
    #[arg(short = 'n', long, default_value_t = 100)]
    pub limit: i64,
}

pub fn ready(store: &Store, a: ReadyArgs, json_out: bool) -> Result<()> {
    let f = Filter {
        issue_type: a.issue_type.as_deref().map(issue::normalize_type),
        labels: split(&a.label),
        descendants_of: a.parent,
        unassigned: a.unassigned,
        ..Default::default()
    };
    let rows = query(store.conn(), "ready_issues", &f, Order::PriorityCreated, a.limit)?;
    emit(store.conn(), &rows, json_out)
}

// ----------------------------------------------------------------- search

#[derive(Args)]
pub struct SearchArgs {
    /// Matched case-insensitively against title and id.
    pub query: String,
    /// Status filter, comma-separated, or `all` (default excludes closed).
    #[arg(short = 's', long)]
    pub status: Option<String>,
    #[arg(short = 't', long = "type")]
    pub issue_type: Option<String>,
    #[arg(short = 'l', long, value_delimiter = ',')]
    pub label: Vec<String>,
    /// Max rows, 0 = unlimited.
    #[arg(short = 'n', long, default_value_t = 50)]
    pub limit: i64,
}

pub fn search(store: &Store, a: SearchArgs, json_out: bool) -> Result<()> {
    let f = Filter {
        statuses: parse_statuses(a.status.as_deref(), false, not_closed())?,
        issue_type: a.issue_type.as_deref().map(issue::normalize_type),
        labels: split(&a.label),
        text: Some(a.query),
        ..Default::default()
    };
    let rows = query(store.conn(), "issues", &f, Order::PriorityUpdated, a.limit)?;
    emit(store.conn(), &rows, json_out)
}

// --------------------------------------------------------------- children

#[derive(Args)]
pub struct ChildrenArgs {
    pub id: String,
}

pub fn children_of(conn: &Connection, id: &str) -> Result<Vec<Issue>> {
    let mut stmt = conn.prepare_cached(&format!(
        "select {COLUMNS} from issues where parent_id=?1
         order by cast(substr(id, length(?1) + 2) as integer), id"
    ))?;
    let rows = stmt.query_map([id], Issue::from_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn children(store: &Store, a: ChildrenArgs, json_out: bool) -> Result<()> {
    issue::require(store.conn(), &a.id)?;
    let rows = children_of(store.conn(), &a.id)?;
    emit(store.conn(), &rows, json_out)
}

// ------------------------------------------------------------------- show

#[derive(Args)]
pub struct ShowArgs {
    #[arg(required = true)]
    pub ids: Vec<String>,
    /// Include comment bodies.
    #[arg(long)]
    pub include_comments: bool,
    /// Omit dependency bodies from show output; keep id, title, status, priority, and type.
    #[arg(long)]
    pub compact_deps: bool,
}

fn icon(status: &str) -> &'static str {
    match status {
        "closed" => "✓",
        "in_progress" => "◐",
        "blocked" => "●",
        "deferred" => "❄",
        _ => "○",
    }
}

fn day(ts: &str) -> &str {
    ts.get(..10).unwrap_or(ts)
}

fn section(out: &mut String, name: &str, body: &str) {
    if body.trim().is_empty() {
        return;
    }
    out.push_str(&format!("\n{name}\n"));
    for line in body.lines() {
        out.push_str(&format!("  {line}\n"));
    }
}

fn human(conn: &Connection, i: &Issue, m: &Map<String, Value>, include_comments: bool) -> Result<String> {
    let mut out = format!(
        "{} {} · {}   [● P{} · {}]\n",
        icon(&i.status),
        i.id,
        i.title,
        i.priority,
        i.status.to_uppercase()
    );
    let mut who = vec![format!("Owner: {}", i.created_by.as_deref().or(i.owner.as_deref()).unwrap_or("-"))];
    if let Some(a) = i.assignee.as_deref().filter(|a| !a.is_empty()) {
        who.push(format!("Assignee: {a}"));
    }
    who.push(format!("Type: {}", i.issue_type));
    out.push_str(&who.join(" · "));
    out.push('\n');
    let mut when = vec![format!("Created: {}", day(&i.created_at))];
    if let Some(s) = &i.started_at {
        when.push(format!("Started: {}", day(s)));
    }
    when.push(format!("Updated: {}", day(&i.updated_at)));
    if let Some(c) = &i.closed_at {
        when.push(format!("Closed: {}", day(c)));
    }
    out.push_str(&when.join(" · "));
    out.push('\n');
    if let Some(r) = &i.close_reason {
        out.push_str(&format!("Close reason: {r}\n"));
    }
    section(&mut out, "DESCRIPTION", if i.description.is_empty() { "(none)" } else { &i.description });
    section(&mut out, "DESIGN", &i.design);
    section(&mut out, "ACCEPTANCE CRITERIA", &i.acceptance_criteria);
    section(&mut out, "NOTES", &i.notes);
    if let Some(Value::Array(ls)) = m.get("labels") {
        let ls: Vec<&str> = ls.iter().filter_map(Value::as_str).collect();
        out.push_str(&format!("\nLABELS: {}\n", ls.join(", ")));
    }
    let mut parent = String::new();
    let mut depends = String::new();
    if let Some(Value::Array(deps)) = m.get("dependencies") {
        for d in deps {
            let line = format!(
                "{} {}: {} ● P{}\n",
                icon(d["status"].as_str().unwrap_or("")),
                d["id"].as_str().unwrap_or(""),
                d["title"].as_str().unwrap_or(""),
                d["priority"]
            );
            if d["dependency_type"] == "parent-child" {
                parent.push_str(&format!("↑ {line}"));
            } else {
                depends.push_str(&format!("→ {line}"));
            }
        }
    }
    section(&mut out, "PARENT", &parent);
    section(&mut out, "DEPENDS ON", &depends);
    let mut blocks = String::new();
    let mut stmt = conn.prepare_cached(
        "select i.id, i.title, i.status, d.type from deps d join issues i on i.id = d.issue_id
         where d.depends_on=?1 order by i.id",
    )?;
    let mut rows = stmt.query([&i.id])?;
    while let Some(r) = rows.next()? {
        let (id, title, status, ty): (String, String, String, String) = (r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?);
        blocks.push_str(&format!("← {} {id}: {title} ({ty})\n", icon(&status)));
    }
    section(&mut out, "BLOCKS", &blocks);
    let kids: String = children_of(conn, &i.id)?
        .iter()
        .map(|c| format!("↳ {} {}: {}\n", icon(&c.status), c.id, c.title))
        .collect();
    section(&mut out, "CHILDREN", &kids);
    if include_comments {
        let cs: String = json::comments(conn, &i.id)?
            .iter()
            .map(|c| {
                format!(
                    "[{}] at {}\n  {}\n",
                    c["author"].as_str().unwrap_or(""),
                    c["created_at"].as_str().unwrap_or(""),
                    c["text"].as_str().unwrap_or("").replace('\n', "\n  ")
                )
            })
            .collect();
        section(&mut out, "COMMENTS", &cs);
    }
    Ok(out)
}

pub fn show(store: &Store, a: ShowArgs, json_out: bool) -> Result<()> {
    let conn = store.conn();
    let mut items = Vec::new();
    for id in &a.ids {
        let i = issue::require(conn, id)?;
        let m = json::show(conn, &i, a.include_comments, a.compact_deps)?;
        items.push((i, m));
    }
    if json_out {
        let arr: Vec<Value> = items.into_iter().map(|(_, m)| Value::Object(m)).collect();
        println!("{}", serde_json::to_string_pretty(&Value::Array(arr))?);
    } else {
        let texts = items
            .iter()
            .map(|(i, m)| human(conn, i, m, a.include_comments))
            .collect::<Result<Vec<_>>>()?;
        print!("{}", texts.join("\n"));
    }
    Ok(())
}

// ---------------------------------------------------------------- history

#[derive(Args)]
pub struct HistoryArgs {
    pub id: String,
    /// Max events, 0 = all.
    #[arg(long, default_value_t = 0)]
    pub limit: i64,
}

pub fn history(store: &Store, a: HistoryArgs, json_out: bool) -> Result<()> {
    let conn = store.conn();
    let limit = if a.limit > 0 { format!(" limit {}", a.limit) } else { String::new() };
    let mut stmt = conn.prepare(&format!(
        "select id, issue_id, kind, field, old_value, new_value, reason, actor, created_at
         from events where issue_id=?1 order by created_at, id{limit}"
    ))?;
    let mut rows = stmt.query([&a.id])?;
    let mut events = Vec::new();
    while let Some(r) = rows.next()? {
        let mut m = Map::new();
        m.insert("id".into(), json!(r.get::<_, i64>(0)?));
        let names = ["issue_id", "kind", "field", "old_value", "new_value", "reason", "actor", "created_at"];
        for (n, k) in names.iter().enumerate() {
            if let Some(v) = r.get::<_, Option<String>>(n + 1)? {
                m.insert((*k).into(), json!(v));
            }
        }
        events.push(Value::Object(m));
    }
    if events.is_empty() && issue::get(conn, &a.id)?.is_none() {
        return Err(error::not_found(&a.id));
    }
    if json_out {
        println!("{}", serde_json::to_string_pretty(&Value::Array(events))?);
    } else {
        let short = |v: &Value| {
            let s = v.as_str().unwrap_or("");
            let one: String = s.replace('\n', "⏎");
            if one.chars().count() > 60 {
                format!("{}…", one.chars().take(60).collect::<String>())
            } else {
                one
            }
        };
        for e in &events {
            let mut line = format!(
                "{} {} {}",
                e["created_at"].as_str().unwrap_or(""),
                e["actor"].as_str().unwrap_or(""),
                e["kind"].as_str().unwrap_or("")
            );
            if let Some(f) = e.get("field") {
                line.push_str(&format!(" {}", f.as_str().unwrap_or("")));
            }
            match (e.get("old_value"), e.get("new_value")) {
                (Some(o), Some(n)) => line.push_str(&format!(": {} -> {}", short(o), short(n))),
                (None, Some(n)) => line.push_str(&format!(": {}", short(n))),
                (Some(o), None) => line.push_str(&format!(": was {}", short(o))),
                (None, None) => {}
            }
            if let Some(r) = e.get("reason") {
                line.push_str(&format!(" ({})", short(r)));
            }
            println!("{line}");
        }
    }
    Ok(())
}

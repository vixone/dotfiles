//! One-shot import from a beads (Dolt) store. Reads `dolt sql -r json`
//! output for 7 tables, either live from the Dolt db dir or from a dump dir
//! of `<table>.json` files. Runs in one transaction with foreign keys off,
//! then checks them before committing: any violation rolls everything back.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use clap::Args;
use rusqlite::Connection;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error;
use crate::store::{now_rfc3339, Store};

const TABLES: &[&str] = &[
    "issues",
    "dependencies",
    "labels",
    "comments",
    "events",
    "config",
    "child_counters",
];
const MIGRATED_FROM: &str = "beads-1.2.2";

#[derive(Args)]
pub struct ImportArgs {
    /// Dolt database dir of the beads store (e.g. .beads/embeddeddolt/mission).
    #[arg(long, value_name = "DOLT_DB_DIR", required_unless_present = "dump_dir")]
    pub from_beads: Option<PathBuf>,
    /// Read <table>.json dumps from this dir instead of running dolt.
    #[arg(long, value_name = "DIR")]
    pub dump_dir: Option<PathBuf>,
    /// Replace the contents of a non-empty store.
    #[arg(long)]
    pub force: bool,
    /// Rewrite an actor name everywhere, e.g. --map-actor 'jdoe=Jane Doe'.
    #[arg(long, value_name = "OLD=NEW")]
    pub map_actor: Vec<String>,
}

#[derive(Deserialize)]
struct Rows<T> {
    #[serde(default = "Vec::new")]
    rows: Vec<T>,
}

#[derive(Deserialize)]
struct BIssue {
    id: String,
    title: String,
    description: Option<String>,
    design: Option<String>,
    acceptance_criteria: Option<String>,
    notes: Option<String>,
    status: Option<String>,
    priority: Option<i64>,
    issue_type: Option<String>,
    assignee: Option<String>,
    owner: Option<String>,
    created_by: Option<String>,
    created_at: String,
    updated_at: Option<String>,
    started_at: Option<String>,
    closed_at: Option<String>,
    close_reason: Option<String>,
}

#[derive(Deserialize)]
struct BDep {
    issue_id: String,
    depends_on_issue_id: Option<String>,
    #[serde(rename = "type")]
    ty: String,
    created_at: Option<String>,
}

#[derive(Deserialize)]
struct BLabel {
    issue_id: String,
    label: String,
}

#[derive(Deserialize)]
struct BComment {
    issue_id: String,
    author: Option<String>,
    text: String,
    created_at: String,
}

#[derive(Deserialize)]
struct BEvent {
    issue_id: Option<String>,
    event_type: String,
    actor: Option<String>,
    comment: Option<String>,
    old_value: Option<String>,
    new_value: Option<String>,
    created_at: String,
}

#[derive(Deserialize)]
struct BConfig {
    key: String,
    value: Option<String>,
}

#[derive(Deserialize)]
struct BCounter {
    parent_id: String,
    last_child: i64,
}

enum Source {
    Dolt(PathBuf),
    Dump(PathBuf),
}

impl Source {
    fn load<T: DeserializeOwned>(&self, table: &str) -> Result<Vec<T>> {
        let raw = match self {
            Source::Dump(dir) => {
                let p = dir.join(format!("{table}.json"));
                std::fs::read(&p).with_context(|| format!("read {}", p.display()))?
            }
            Source::Dolt(dir) => {
                let out = Command::new("dolt")
                    .args(["sql", "-r", "json", "-q", &format!("select * from `{table}`")])
                    .current_dir(dir)
                    .output()
                    .context("run dolt (is it on PATH?)")?;
                if !out.status.success() {
                    bail!(
                        "dolt sql on {table} failed: {}",
                        String::from_utf8_lossy(&out.stderr).trim()
                    );
                }
                out.stdout
            }
        };
        if raw.iter().all(u8::is_ascii_whitespace) {
            return Ok(Vec::new());
        }
        let rows: Rows<T> = serde_json::from_slice(&raw).with_context(|| format!("parse {table} rows"))?;
        Ok(rows.rows)
    }
}

/// `2026-01-02 11:00:00.123` -> `2026-01-02T11:00:00Z`.
fn ts(v: &str) -> String {
    let v = v.trim().trim_end_matches('Z');
    let v = v.split('.').next().unwrap_or(v);
    let v = v.split('+').next().unwrap_or(v);
    format!("{}Z", v.replacen(' ', "T", 1))
}

fn ts_opt(v: &Option<String>) -> Option<String> {
    v.as_deref().filter(|s| !s.trim().is_empty()).map(ts)
}

fn nonempty(v: &Option<String>) -> Option<String> {
    v.as_deref().filter(|s| !s.is_empty()).map(String::from)
}

fn dep_type(t: &str) -> Option<&'static str> {
    match t {
        "blocks" => Some("blocks"),
        "relates-to" | "related" | "relates_to" | "discovered-from" => Some("relates_to"),
        _ => None,
    }
}

fn parse_obj(s: &Option<String>) -> serde_json::Map<String, Value> {
    match s.as_deref().map(serde_json::from_str::<Value>) {
        Some(Ok(Value::Object(m))) => m,
        _ => serde_json::Map::new(),
    }
}

fn val_str(v: Option<&Value>) -> Option<String> {
    match v {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => Some(other.to_string()),
    }
}

struct ActorMap(HashMap<String, String>);

impl ActorMap {
    fn parse(raw: &[String]) -> Result<Self> {
        let mut m = HashMap::new();
        for r in raw {
            let Some((from, to)) = r.split_once('=') else {
                return Err(error::usage(format!("--map-actor {r:?}: expected OLD=NEW")));
            };
            m.insert(from.to_string(), to.to_string());
        }
        Ok(ActorMap(m))
    }

    fn map(&self, v: Option<String>) -> Option<String> {
        v.map(|s| self.0.get(&s).cloned().unwrap_or(s))
    }
}

/// One events row ready to insert.
struct Ev {
    kind: String,
    field: Option<String>,
    old: Option<String>,
    new: Option<String>,
    reason: Option<String>,
}

/// Beads stores full issue snapshots on many events (141MB of them). Keep
/// only the field that changed; notes appends become deltas.
fn convert_event(e: &BEvent) -> Vec<Ev> {
    let ev = |kind: &str, field: Option<&str>, old: Option<String>, new: Option<String>, reason: Option<String>| Ev {
        kind: kind.into(),
        field: field.map(String::from),
        old,
        new,
        reason,
    };
    let comment = nonempty(&e.comment);
    match e.event_type.as_str() {
        "updated" => {
            let (o, n) = (parse_obj(&e.old_value), parse_obj(&e.new_value));
            n.iter()
                .map(|(f, nv)| {
                    let ov = o.get(f);
                    if let (Some(Value::String(os)), Value::String(ns)) = (ov, nv) {
                        if f == "notes" && ns.starts_with(os.as_str()) {
                            let delta = ns[os.len()..].trim_start_matches('\n').to_string();
                            return ev("note_appended", Some("notes"), None, Some(delta), None);
                        }
                    }
                    ev("updated", Some(f), val_str(ov), val_str(Some(nv)), comment.clone())
                })
                .collect()
        }
        "status_changed" | "reopened" => {
            let (o, n) = (parse_obj(&e.old_value), parse_obj(&e.new_value));
            vec![ev(
                &e.event_type,
                Some("status"),
                val_str(o.get("status")),
                val_str(n.get("status")),
                comment,
            )]
        }
        "claimed" => {
            let (o, n) = (parse_obj(&e.old_value), parse_obj(&e.new_value));
            vec![ev("claimed", Some("assignee"), val_str(o.get("assignee")), val_str(n.get("assignee")), comment)]
        }
        "closed" => vec![ev(
            "closed",
            Some("status"),
            None,
            Some("closed".into()),
            nonempty(&e.new_value).or(comment),
        )],
        "label_added" => {
            let label = comment.as_deref().and_then(|c| c.strip_prefix("Added label: ")).map(String::from);
            vec![ev("label_added", Some("labels"), None, label, None)]
        }
        "label_removed" => {
            let label = comment.as_deref().and_then(|c| c.strip_prefix("Removed label: ")).map(String::from);
            vec![ev("label_removed", Some("labels"), label, None, None)]
        }
        "created" => vec![ev("created", None, None, None, comment)],
        other => {
            // Unknown kind: keep small values, drop snapshots.
            let small = |v: &Option<String>| nonempty(v).filter(|s| s.len() <= 1024);
            vec![ev(other, None, small(&e.old_value), small(&e.new_value), comment)]
        }
    }
}

#[derive(Default)]
struct Report {
    counts: BTreeMap<&'static str, i64>,
    skipped_deps: i64,
    fk_violations: Vec<String>,
}

fn is_empty(conn: &Connection) -> Result<bool> {
    Ok(conn.query_row(
        "select not exists(select 1 from issues) and not exists(select 1 from memories)",
        [],
        |r| r.get(0),
    )?)
}

fn load(tx: &Connection, src: &Source, actors: &ActorMap, now: &str) -> Result<Report> {
    let mut rep = Report::default();
    let issues: Vec<BIssue> = src.load("issues")?;
    let deps: Vec<BDep> = src.load("dependencies")?;
    let counters: HashMap<String, i64> = src
        .load::<BCounter>("child_counters")?
        .into_iter()
        .map(|c| (c.parent_id, c.last_child))
        .collect();
    let mut parent: HashMap<&str, &str> = HashMap::new();
    for d in &deps {
        if let (true, Some(p)) = (d.ty == "parent-child", d.depends_on_issue_id.as_deref()) {
            parent.insert(d.issue_id.as_str(), p);
        }
    }

    let mut ins = tx.prepare(
        "insert into issues(id, title, description, design, acceptance_criteria, notes, status, priority,
             issue_type, parent_id, assignee, owner, created_by, created_at, updated_at, started_at,
             closed_at, close_reason, last_child)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
    )?;
    for i in &issues {
        let created = ts(&i.created_at);
        let status = i
            .status
            .as_deref()
            .filter(|s| crate::issue::STATUSES.contains(s))
            .unwrap_or("open");
        ins.execute(rusqlite::params![
            i.id,
            i.title,
            i.description.clone().unwrap_or_default(),
            i.design.clone().unwrap_or_default(),
            i.acceptance_criteria.clone().unwrap_or_default(),
            i.notes.clone().unwrap_or_default(),
            status,
            i.priority.unwrap_or(2).clamp(0, 4),
            nonempty(&i.issue_type).unwrap_or_else(|| "task".into()),
            parent.get(i.id.as_str()),
            actors.map(nonempty(&i.assignee)),
            nonempty(&i.owner),
            actors.map(nonempty(&i.created_by)),
            created,
            ts_opt(&i.updated_at).unwrap_or_else(|| created.clone()),
            ts_opt(&i.started_at),
            ts_opt(&i.closed_at),
            nonempty(&i.close_reason),
            counters.get(&i.id).copied().unwrap_or(0),
        ])?;
    }
    drop(ins);
    // Never hand out an id that already exists, whatever the counter said.
    tx.execute_batch(
        "update issues set last_child = max(last_child, coalesce((
             select max(cast(substr(c.id, length(issues.id) + 2) as integer)) from issues c
             where c.parent_id = issues.id and c.id like issues.id || '.%'
               and substr(c.id, length(issues.id) + 2) not like '%.%'), 0))",
    )?;

    let mut ins = tx.prepare(
        "insert or ignore into deps(issue_id, depends_on, type, created_at) values (?1, ?2, ?3, ?4)",
    )?;
    for d in &deps {
        if d.ty == "parent-child" {
            continue;
        }
        match (d.depends_on_issue_id.as_deref().filter(|s| !s.is_empty()), dep_type(&d.ty)) {
            (Some(to), Some(ty)) => {
                let at = ts_opt(&d.created_at).unwrap_or_else(|| now.to_string());
                ins.execute((&d.issue_id, to, ty, at))?;
            }
            _ => rep.skipped_deps += 1,
        }
    }
    drop(ins);

    let mut ins = tx.prepare("insert or ignore into labels(issue_id, label) values (?1, ?2)")?;
    for l in src.load::<BLabel>("labels")? {
        ins.execute((&l.issue_id, &l.label))?;
    }
    drop(ins);

    let mut ins =
        tx.prepare("insert into comments(issue_id, author, text, created_at) values (?1, ?2, ?3, ?4)")?;
    for c in src.load::<BComment>("comments")? {
        let author = actors.map(nonempty(&c.author)).unwrap_or_else(|| "unknown".into());
        ins.execute((&c.issue_id, author, &c.text, ts(&c.created_at)))?;
    }
    drop(ins);

    let mut ins = tx.prepare(
        "insert into memories(key, text, created_at, updated_at) values (?1, ?2, ?3, ?3)",
    )?;
    for c in src.load::<BConfig>("config")? {
        if let Some(key) = c.key.strip_prefix("kv.memory.") {
            ins.execute((key, c.value.unwrap_or_default(), now))?;
        }
    }
    drop(ins);

    let mut events: Vec<BEvent> = src.load("events")?;
    events.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    let mut ins = tx.prepare(
        "insert into events(issue_id, kind, field, old_value, new_value, reason, actor, created_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?;
    for e in &events {
        let actor = actors.map(nonempty(&e.actor)).unwrap_or_else(|| "unknown".into());
        let at = ts(&e.created_at);
        for r in convert_event(e) {
            ins.execute(rusqlite::params![e.issue_id, r.kind, r.field, r.old, r.new, r.reason, actor, at])?;
        }
    }
    drop(ins);

    tx.execute(
        "insert into meta(key, value) values ('migrated_from', ?1), ('imported_at', ?2)
         on conflict(key) do update set value=excluded.value",
        (MIGRATED_FROM, now),
    )?;

    for t in ["issues", "deps", "labels", "comments", "memories", "events"] {
        let n: i64 = tx.query_row(&format!("select count(*) from {t}"), [], |r| r.get(0))?;
        rep.counts.insert(t, n);
    }
    let mut stmt = tx.prepare("pragma foreign_key_check")?;
    let mut rows = stmt.query([])?;
    while let Some(r) = rows.next()? {
        let table: String = r.get(0)?;
        let rowid: Option<i64> = r.get(1)?;
        let parent: String = r.get(2)?;
        rep.fk_violations.push(format!("{table} rowid {rowid:?} -> {parent}"));
    }
    Ok(rep)
}

pub fn import(store: &mut Store, a: ImportArgs, json_out: bool) -> Result<()> {
    let src = match (&a.dump_dir, &a.from_beads) {
        (Some(d), _) => Source::Dump(d.clone()),
        (None, Some(p)) => Source::Dolt(p.clone()),
        (None, None) => return Err(error::usage("give --from-beads <dolt-db-dir> or --dump-dir <dir>")),
    };
    check_source(&src)?;
    let actors = ActorMap::parse(&a.map_actor)?;
    if !is_empty(store.conn())? && !a.force {
        return Err(error::invalid(format!(
            "{} is not empty; pass --force to replace its contents",
            store.path().display()
        )));
    }
    let now = now_rfc3339();
    store.conn().execute_batch("pragma foreign_keys = OFF")?;
    let result = store.write_no_backup(|tx| {
        tx.execute_batch(
            "delete from deps; delete from labels; delete from comments; delete from events;
             delete from memories; delete from issues;",
        )?;
        let rep = load(tx, &src, &actors, &now)?;
        if !rep.fk_violations.is_empty() {
            for v in rep.fk_violations.iter().take(20) {
                eprintln!("fk violation: {v}");
            }
            return Err(error::invalid(format!(
                "{} foreign key violation(s); nothing imported",
                rep.fk_violations.len()
            )));
        }
        // The dated backup may still belong to the store that was just replaced.
        tx.execute("delete from meta where key='last_backup_date'", [])?;
        Ok(rep)
    });
    store.conn().execute_batch("pragma foreign_keys = ON")?;
    let rep = result?;

    if json_out {
        let mut m = serde_json::Map::new();
        for (k, v) in &rep.counts {
            m.insert((*k).into(), json!(v));
        }
        m.insert("skipped_deps".into(), json!(rep.skipped_deps));
        m.insert("fk_violations".into(), json!(rep.fk_violations.len()));
        println!("{}", serde_json::to_string_pretty(&Value::Object(m))?);
    } else {
        for (k, v) in &rep.counts {
            println!("{k:<9} {v}");
        }
        println!("skipped_deps {}", rep.skipped_deps);
        println!("fk_violations 0");
    }
    Ok(())
}

fn check_source(src: &Source) -> Result<()> {
    match src {
        Source::Dump(d) => {
            for t in TABLES {
                let p = d.join(format!("{t}.json"));
                if !p.exists() {
                    return Err(error::invalid(format!("missing dump file {}", p.display())));
                }
            }
        }
        Source::Dolt(d) => {
            if !Path::new(d).join(".dolt").exists() {
                return Err(error::invalid(format!(
                    "{} is not a Dolt database dir (no .dolt/)",
                    d.display()
                )));
            }
        }
    }
    Ok(())
}

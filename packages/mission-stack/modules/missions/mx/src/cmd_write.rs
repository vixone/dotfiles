//! Write commands: create, update, note, comment, dep add, link, delete.
//! Every mutation runs in one BEGIN IMMEDIATE transaction, logs events rows
//! and bumps updated_at. Secret scans run before the transaction opens.

use std::collections::BTreeSet;
use std::io::Read;

use anyhow::{Context, Result};
use clap::Args;
use rusqlite::Connection;
use serde_json::{json, Value};

use crate::cmd_close;
use crate::error;
use crate::events::{Actor, Event};
use crate::ids;
use crate::issue;
use crate::secrets;
use crate::store::{now_rfc3339, Store};

// ---------------------------------------------------------------- helpers

fn read_source(path: &str) -> Result<String> {
    if path == "-" {
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s).context("read stdin")?;
        Ok(s)
    } else {
        std::fs::read_to_string(path).with_context(|| format!("read {path}"))
    }
}

/// At most one of inline value, file (`-` = stdin) or `--stdin`.
fn text_input(
    field: &str,
    inline: Option<String>,
    file: Option<&str>,
    stdin: bool,
) -> Result<Option<String>> {
    let given = inline.is_some() as u8 + file.is_some() as u8 + stdin as u8;
    if given > 1 {
        return Err(error::usage(format!(
            "{field} given more than once (inline, file or --stdin)"
        )));
    }
    if let Some(v) = inline {
        return Ok(Some(v));
    }
    if let Some(f) = file {
        return Ok(Some(read_source(f)?));
    }
    if stdin {
        return Ok(Some(read_source("-")?));
    }
    Ok(None)
}

fn split_labels(raw: &[String]) -> BTreeSet<String> {
    raw.iter()
        .flat_map(|s| s.split(','))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

fn print_json(v: &Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(v)?);
    Ok(())
}

fn touch(conn: &Connection, id: &str, now: &str) -> Result<()> {
    conn.execute("update issues set updated_at=?1 where id=?2", (now, id))?;
    Ok(())
}

fn append_note(conn: &Connection, actor: &Actor, now: &str, id: &str, text: &str) -> Result<()> {
    conn.execute(
        "update issues set notes = case when notes = '' then ?1 else notes || char(10) || ?1 end where id=?2",
        (text, id),
    )?;
    Event::issue(id, "note_appended")
        .field("notes")
        .new(Some(text))
        .log(conn, actor, now)
}

/// True if `ancestor` is `id` or one of its ancestors.
fn is_self_or_ancestor(conn: &Connection, id: &str, ancestor: &str) -> Result<bool> {
    Ok(conn.query_row(
        "with recursive up(id, parent) as (
             select id, parent_id from issues where id=?1
             union all
             select i.id, i.parent_id from issues i join up on i.id = up.parent)
         select exists(select 1 from up where id=?2)",
        (id, ancestor),
        |r| r.get(0),
    )?)
}

fn descendants(conn: &Connection, id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare_cached(
        "with recursive d(id) as (
             select id from issues where parent_id=?1
             union all
             select i.id from issues i join d on i.parent_id = d.id)
         select id from d",
    )?;
    let rows = stmt.query_map([id], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Field setter that logs an event per real change.
struct Change<'a> {
    conn: &'a Connection,
    actor: &'a Actor,
    now: &'a str,
    id: &'a str,
    changed: bool,
}

impl Change<'_> {
    fn set(&mut self, col: &'static str, old: Option<&str>, new: Option<&str>) -> Result<()> {
        if old == new {
            return Ok(());
        }
        self.conn
            .execute(&format!("update issues set {col}=?1 where id=?2"), (new, self.id))?;
        Event::issue(self.id, "updated")
            .field(col)
            .old(old)
            .new(new)
            .log(self.conn, self.actor, self.now)?;
        self.changed = true;
        Ok(())
    }

    fn set_priority(&mut self, old: i64, new: i64) -> Result<()> {
        if old == new {
            return Ok(());
        }
        self.conn
            .execute("update issues set priority=?1 where id=?2", (new, self.id))?;
        Event::issue(self.id, "updated")
            .field("priority")
            .old(Some(&old.to_string()))
            .new(Some(&new.to_string()))
            .log(self.conn, self.actor, self.now)?;
        self.changed = true;
        Ok(())
    }

    fn set_status(&mut self, new: &str) -> Result<()> {
        let cur = issue::require(self.conn, self.id)?;
        if cur.status == new {
            return Ok(());
        }
        let c = self.conn;
        if new == "closed" {
            // Same checks and event as `mx close`.
            if let Some(msg) = cmd_close::refusal(c, &cur, false)? {
                return Err(error::invalid(msg));
            }
            cmd_close::close_issue(c, self.actor, self.now, &cur, cmd_close::DEFAULT_REASON)?;
            self.changed = true;
            return Ok(());
        }
        c.execute("update issues set status=?1 where id=?2", (new, self.id))?;
        if new == "in_progress" && cur.started_at.is_none() {
            c.execute("update issues set started_at=?1 where id=?2", (self.now, self.id))?;
        }
        if cur.status == "closed" {
            c.execute(
                "update issues set closed_at=NULL, close_reason=NULL where id=?1",
                [self.id],
            )?;
        }
        Event::issue(self.id, "status_changed")
            .field("status")
            .old(Some(&cur.status))
            .new(Some(new))
            .log(c, self.actor, self.now)?;
        self.changed = true;
        Ok(())
    }

    fn add_label(&mut self, label: &str) -> Result<()> {
        let n = self.conn.execute(
            "insert or ignore into labels(issue_id, label) values (?1, ?2)",
            (self.id, label),
        )?;
        if n > 0 {
            Event::issue(self.id, "label_added")
                .field("labels")
                .new(Some(label))
                .log(self.conn, self.actor, self.now)?;
            self.changed = true;
        }
        Ok(())
    }

    fn remove_label(&mut self, label: &str) -> Result<()> {
        let n = self.conn.execute(
            "delete from labels where issue_id=?1 and label=?2",
            (self.id, label),
        )?;
        if n > 0 {
            Event::issue(self.id, "label_removed")
                .field("labels")
                .old(Some(label))
                .log(self.conn, self.actor, self.now)?;
            self.changed = true;
        }
        Ok(())
    }
}

// ----------------------------------------------------------------- create

#[derive(Args)]
pub struct CreateArgs {
    /// Issue title.
    pub title: Option<String>,
    /// Issue title (alternative to the positional argument).
    #[arg(long = "title", value_name = "TITLE")]
    pub title_flag: Option<String>,
    /// Issue type (task, epic, bug, feature, decision, ...).
    #[arg(short = 't', long = "type", default_value = "task")]
    pub issue_type: String,
    /// Priority 0-4 or P0-P4 (0 is highest).
    #[arg(short = 'p', long, default_value = "2")]
    pub priority: String,
    #[arg(short = 'd', long)]
    pub description: Option<String>,
    /// Read the description from a file (- for stdin).
    #[arg(long, value_name = "FILE")]
    pub body_file: Option<String>,
    /// Read the description from stdin.
    #[arg(long)]
    pub stdin: bool,
    #[arg(long)]
    pub design: Option<String>,
    /// Read the design from a file (- for stdin).
    #[arg(long, value_name = "FILE")]
    pub design_file: Option<String>,
    #[arg(long)]
    pub acceptance: Option<String>,
    #[arg(long)]
    pub notes: Option<String>,
    /// Parent issue; the child id is <parent>.<n>.
    #[arg(long)]
    pub parent: Option<String>,
    /// Comma-separated labels.
    #[arg(short = 'l', long, value_delimiter = ',')]
    pub labels: Vec<String>,
    /// Do not copy the parent's labels.
    #[arg(long)]
    pub no_inherit_labels: bool,
    #[arg(short = 'a', long)]
    pub assignee: Option<String>,
    /// Print only the new id.
    #[arg(long)]
    pub silent: bool,
}

pub fn create(store: &mut Store, a: CreateArgs, json_out: bool) -> Result<()> {
    let title = match (a.title, a.title_flag) {
        (Some(t), None) | (None, Some(t)) => t,
        (Some(p), Some(f)) if p == f => p,
        (Some(_), Some(_)) => return Err(error::usage("title given both positionally and with --title")),
        (None, None) => return Err(error::usage("create needs a title")),
    };
    if title.trim().is_empty() {
        return Err(error::usage("title is empty"));
    }
    let description =
        text_input("description", a.description, a.body_file.as_deref(), a.stdin)?.unwrap_or_default();
    let design = text_input("design", a.design, a.design_file.as_deref(), false)?.unwrap_or_default();
    let acceptance = a.acceptance.unwrap_or_default();
    let notes = a.notes.unwrap_or_default();
    let priority = issue::parse_priority(&a.priority)?;
    let issue_type = issue::normalize_type(&a.issue_type);
    if issue_type.is_empty() {
        return Err(error::usage("--type is empty"));
    }
    secrets::check(&[
        ("title", &title),
        ("description", &description),
        ("design", &design),
        ("acceptance", &acceptance),
        ("notes", &notes),
    ])?;

    let mut labels = split_labels(&a.labels);
    let parent = a.parent.filter(|p| !p.is_empty());
    let assignee = a.assignee.filter(|v| !v.is_empty());
    let actor = Actor::resolve();
    let now = now_rfc3339();

    let id = store.write(|tx| {
        let id = match parent.as_deref() {
            Some(p) => {
                if issue::get(tx, p)?.is_none() {
                    return Err(error::invalid(format!("parent issue {p} not found")));
                }
                if !a.no_inherit_labels {
                    labels.extend(issue::labels(tx, p)?);
                }
                ids::next_child_id(tx, p)?
            }
            None => ids::new_top_id(tx)?,
        };
        tx.execute(
            "insert into issues(id, title, description, design, acceptance_criteria, notes, priority,
                                issue_type, parent_id, assignee, owner, created_by, created_at, updated_at)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
            rusqlite::params![
                id,
                title,
                description,
                design,
                acceptance,
                notes,
                priority,
                issue_type,
                parent,
                assignee,
                None::<String>,
                actor.name,
                now,
            ],
        )?;
        for l in &labels {
            tx.execute("insert into labels(issue_id, label) values (?1, ?2)", (&id, l))?;
        }
        Event::issue(&id, "created").new(Some(&title)).log(tx, &actor, &now)?;
        Ok(id)
    })?;

    if a.silent {
        println!("{id}");
    } else if json_out {
        print_json(&issue::with_schema_version(issue::json(store.conn(), &id)?))?;
    } else {
        println!("✓ Created issue: {id}: {title}");
    }
    Ok(())
}

// ----------------------------------------------------------------- update

#[derive(Args)]
pub struct UpdateArgs {
    #[arg(required = true)]
    pub ids: Vec<String>,
    #[arg(short = 's', long)]
    pub status: Option<String>,
    /// Set assignee to you and status to in_progress.
    #[arg(long)]
    pub claim: bool,
    /// New parent ('' removes the parent).
    #[arg(long)]
    pub parent: Option<String>,
    #[arg(long)]
    pub title: Option<String>,
    #[arg(short = 'd', long)]
    pub description: Option<String>,
    #[arg(long, value_name = "FILE")]
    pub body_file: Option<String>,
    #[arg(long)]
    pub stdin: bool,
    #[arg(long)]
    pub design: Option<String>,
    #[arg(long, value_name = "FILE")]
    pub design_file: Option<String>,
    #[arg(long)]
    pub acceptance: Option<String>,
    /// Replace the notes field.
    #[arg(long)]
    pub notes: Option<String>,
    /// Append to notes with a newline separator.
    #[arg(long)]
    pub append_notes: Option<String>,
    #[arg(short = 'p', long)]
    pub priority: Option<String>,
    #[arg(short = 't', long = "type")]
    pub issue_type: Option<String>,
    /// Assignee ('' clears it).
    #[arg(short = 'a', long)]
    pub assignee: Option<String>,
    #[arg(long, value_delimiter = ',')]
    pub add_label: Vec<String>,
    #[arg(long, value_delimiter = ',')]
    pub remove_label: Vec<String>,
    /// Replace all labels ('' clears them).
    #[arg(long, value_delimiter = ',')]
    pub set_labels: Option<Vec<String>>,
}

pub fn update(store: &mut Store, a: UpdateArgs, json_out: bool) -> Result<()> {
    let description = text_input("description", a.description, a.body_file.as_deref(), a.stdin)?;
    let design = text_input("design", a.design, a.design_file.as_deref(), false)?;
    let priority = a.priority.as_deref().map(issue::parse_priority).transpose()?;
    let status = a.status.as_deref().map(issue::parse_status).transpose()?;
    let issue_type = a.issue_type.as_deref().map(issue::normalize_type);
    let add = split_labels(&a.add_label);
    let remove = split_labels(&a.remove_label);
    let set_labels = a.set_labels.as_deref().map(split_labels);

    let anything = a.title.is_some()
        || description.is_some()
        || design.is_some()
        || a.acceptance.is_some()
        || a.notes.is_some()
        || a.append_notes.is_some()
        || priority.is_some()
        || status.is_some()
        || issue_type.is_some()
        || a.assignee.is_some()
        || a.parent.is_some()
        || a.claim
        || !add.is_empty()
        || !remove.is_empty()
        || set_labels.is_some();
    if !anything {
        return Err(error::usage("no updates specified"));
    }
    let opt = |v: &Option<String>| v.clone().unwrap_or_default();
    secrets::check(&[
        ("title", &opt(&a.title)),
        ("description", &opt(&description)),
        ("design", &opt(&design)),
        ("acceptance", &opt(&a.acceptance)),
        ("notes", &opt(&a.notes)),
        ("notes", &opt(&a.append_notes)),
    ])?;

    let actor = Actor::resolve();
    let now = now_rfc3339();
    store.write(|tx| {
        for id in &a.ids {
            let cur = issue::require(tx, id)?;
            let mut ch = Change { conn: tx, actor: &actor, now: &now, id, changed: false };
            if let Some(v) = &a.title {
                ch.set("title", Some(&cur.title), Some(v))?;
            }
            if let Some(v) = &description {
                ch.set("description", Some(&cur.description), Some(v))?;
            }
            if let Some(v) = &design {
                ch.set("design", Some(&cur.design), Some(v))?;
            }
            if let Some(v) = &a.acceptance {
                ch.set("acceptance_criteria", Some(&cur.acceptance_criteria), Some(v))?;
            }
            if let Some(v) = &a.notes {
                ch.set("notes", Some(&cur.notes), Some(v))?;
            }
            if let Some(v) = a.append_notes.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
                append_note(tx, &actor, &now, id, v)?;
                ch.changed = true;
            }
            if let Some(p) = priority {
                ch.set_priority(cur.priority, p)?;
            }
            if let Some(t) = &issue_type {
                ch.set("issue_type", Some(&cur.issue_type), Some(t))?;
            }
            if let Some(v) = &a.assignee {
                let new = Some(v.as_str()).filter(|v| !v.is_empty());
                ch.set("assignee", cur.assignee.as_deref(), new)?;
            }
            if let Some(p) = &a.parent {
                let new = if p.is_empty() {
                    None
                } else {
                    if issue::get(tx, p)?.is_none() {
                        return Err(error::invalid(format!("parent issue {p} not found")));
                    }
                    if is_self_or_ancestor(tx, p, id)? {
                        return Err(error::invalid(format!(
                            "cannot move {id} under {p}: that would create a parent cycle"
                        )));
                    }
                    Some(p.as_str())
                };
                ch.set("parent_id", cur.parent_id.as_deref(), new)?;
            }
            if let Some(s) = &status {
                ch.set_status(s)?;
            }
            if a.claim {
                let cur = issue::require(tx, id)?;
                if cur.status == "closed" {
                    return Err(error::invalid(format!("{id} is closed; reopen it before claiming")));
                }
                if let Some(who) = cur.assignee.as_deref().filter(|w| !w.is_empty() && *w != actor.name) {
                    return Err(error::invalid(format!("{id} is already claimed by {who}")));
                }
                if cur.assignee.as_deref() != Some(actor.name.as_str()) {
                    tx.execute("update issues set assignee=?1 where id=?2", (&actor.name, id))?;
                    Event::issue(id, "claimed")
                        .field("assignee")
                        .old(cur.assignee.as_deref())
                        .new(Some(&actor.name))
                        .log(tx, &actor, &now)?;
                    ch.changed = true;
                }
                ch.set_status("in_progress")?;
            }
            if let Some(want) = &set_labels {
                let have: BTreeSet<String> = issue::labels(tx, id)?.into_iter().collect();
                for l in have.difference(want) {
                    ch.remove_label(l)?;
                }
                for l in want.difference(&have) {
                    ch.add_label(l)?;
                }
            }
            for l in &add {
                ch.add_label(l)?;
            }
            for l in &remove {
                ch.remove_label(l)?;
            }
            if ch.changed {
                touch(tx, id, &now)?;
            }
        }
        Ok(())
    })?;

    if json_out {
        let rows = a
            .ids
            .iter()
            .map(|id| issue::json(store.conn(), id).map(Value::Object))
            .collect::<Result<Vec<_>>>()?;
        print_json(&Value::Array(rows))?;
    } else {
        for id in &a.ids {
            println!("✓ Updated issue: {id}");
        }
    }
    Ok(())
}

// ---------------------------------------------------------- note, comment

#[derive(Args)]
pub struct TextArgs {
    pub id: String,
    /// Text; several words are joined with spaces.
    pub text: Vec<String>,
    /// Read the text from a file.
    #[arg(long, value_name = "FILE")]
    pub file: Option<String>,
    /// Read the text from stdin.
    #[arg(long)]
    pub stdin: bool,
}

impl TextArgs {
    fn body(&self) -> Result<String> {
        let inline = (!self.text.is_empty()).then(|| self.text.join(" "));
        let raw = text_input("text", inline, self.file.as_deref(), self.stdin)?.unwrap_or_default();
        let text = raw.trim().to_string();
        if text.is_empty() {
            return Err(error::usage("no text given"));
        }
        Ok(text)
    }
}

pub fn note(store: &mut Store, a: TextArgs, json_out: bool) -> Result<()> {
    let text = a.body()?;
    secrets::check(&[("note", &text)])?;
    let actor = Actor::resolve();
    let now = now_rfc3339();
    store.write(|tx| {
        issue::require(tx, &a.id)?;
        append_note(tx, &actor, &now, &a.id, &text)?;
        touch(tx, &a.id, &now)
    })?;
    if json_out {
        print_json(&issue::with_schema_version(issue::json(store.conn(), &a.id)?))?;
    } else {
        println!("✓ Added note to {}", a.id);
    }
    Ok(())
}

pub fn comment(store: &mut Store, a: TextArgs, json_out: bool) -> Result<()> {
    let text = a.body()?;
    secrets::check(&[("comment", &text)])?;
    let actor = Actor::resolve();
    let now = now_rfc3339();
    let cid: i64 = store.write(|tx| {
        issue::require(tx, &a.id)?;
        let cid = tx.query_row(
            "insert into comments(issue_id, author, text, created_at) values (?1, ?2, ?3, ?4) returning id",
            (&a.id, &actor.name, &text, &now),
            |r| r.get(0),
        )?;
        Event::issue(&a.id, "commented").new(Some(&text)).log(tx, &actor, &now)?;
        touch(tx, &a.id, &now)?;
        Ok(cid)
    })?;
    if json_out {
        print_json(&json!({
            "author": actor.name,
            "created_at": now,
            "id": cid,
            "issue_id": a.id,
            "schema_version": 1,
            "text": text,
        }))?;
    } else {
        println!("✓ Comment added to {}", a.id);
    }
    Ok(())
}

// -------------------------------------------------------------- dep, link

#[derive(Args)]
pub struct DepAddArgs {
    /// The issue that is blocked.
    pub issue: String,
    /// The issue it depends on (is blocked by).
    #[arg(value_name = "DEPENDS_ON")]
    pub target: Option<String>,
    #[arg(long, value_name = "ID")]
    pub blocked_by: Option<String>,
    #[arg(long = "depends-on", value_name = "ID")]
    pub depends_on: Option<String>,
    /// blocks or relates_to.
    #[arg(short = 't', long = "type", default_value = "blocks")]
    pub dep_type: String,
}

#[derive(Args)]
pub struct LinkArgs {
    pub id1: String,
    pub id2: String,
    /// blocks (id2 blocks id1) or relates_to.
    #[arg(short = 't', long = "type", default_value = "blocks")]
    pub dep_type: String,
}

fn parse_dep_type(raw: &str) -> Result<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "blocks" => Ok("blocks"),
        "relates_to" | "relates-to" | "related" => Ok("relates_to"),
        other => Err(error::usage(format!(
            "unsupported dependency type {other:?}: use blocks or relates_to"
        ))),
    }
}

pub fn dep_add(store: &mut Store, a: DepAddArgs, json_out: bool) -> Result<()> {
    let target = match (a.target, a.blocked_by, a.depends_on) {
        (Some(t), None, None) | (None, Some(t), None) | (None, None, Some(t)) => t,
        (None, None, None) => return Err(error::usage("dep add needs the id it depends on")),
        _ => return Err(error::usage("give the depends-on id once")),
    };
    add_dep(store, &a.issue, &target, parse_dep_type(&a.dep_type)?, json_out)
}

pub fn link(store: &mut Store, a: LinkArgs, json_out: bool) -> Result<()> {
    add_dep(store, &a.id1, &a.id2, parse_dep_type(&a.dep_type)?, json_out)
}

fn add_dep(store: &mut Store, from: &str, to: &str, ty: &str, json_out: bool) -> Result<()> {
    if from == to {
        return Err(error::invalid(format!("{from} cannot depend on itself")));
    }
    let actor = Actor::resolve();
    let now = now_rfc3339();
    let added = store.write(|tx| {
        issue::require(tx, from)?;
        issue::require(tx, to)?;
        if ty == "blocks" {
            let cycle: bool = tx.query_row(
                "with recursive r(id) as (
                     select ?1
                     union
                     select d.depends_on from deps d join r on d.issue_id = r.id where d.type='blocks')
                 select exists(select 1 from r where id=?2)",
                (to, from),
                |r| r.get(0),
            )?;
            if cycle {
                return Err(error::invalid(format!(
                    "{from} -> {to} would create a dependency cycle"
                )));
            }
        }
        let n = tx.execute(
            "insert or ignore into deps(issue_id, depends_on, type, created_at) values (?1, ?2, ?3, ?4)",
            (from, to, ty, &now),
        )?;
        if n > 0 {
            Event::issue(from, "dep_added")
                .field(ty)
                .new(Some(to))
                .log(tx, &actor, &now)?;
            touch(tx, from, &now)?;
        }
        Ok(n > 0)
    })?;
    if json_out {
        print_json(&json!({
            "depends_on_id": to,
            "issue_id": from,
            "schema_version": 1,
            "status": if added { "added" } else { "exists" },
            "type": ty,
        }))?;
    } else {
        println!("✓ Added dependency: {from} depends on {to} ({ty})");
    }
    Ok(())
}

// ----------------------------------------------------------------- delete

#[derive(Args)]
pub struct DeleteArgs {
    #[arg(required = true)]
    pub ids: Vec<String>,
    /// Actually delete (without it, only a preview is printed).
    #[arg(short = 'f', long)]
    pub force: bool,
    /// Also delete all descendants.
    #[arg(long)]
    pub cascade: bool,
    #[arg(long)]
    pub dry_run: bool,
}

/// Ids to delete, deepest first so parent_id RESTRICT never fires.
fn delete_plan(conn: &Connection, a: &DeleteArgs) -> Result<Vec<String>> {
    let mut set = BTreeSet::new();
    for id in &a.ids {
        issue::require(conn, id)?;
        set.insert(id.clone());
        if a.cascade {
            set.extend(descendants(conn, id)?);
        }
    }
    if !a.cascade {
        for id in &set {
            let kids: Vec<String> = descendants(conn, id)?
                .into_iter()
                .filter(|k| !set.contains(k))
                .collect();
            if !kids.is_empty() {
                return Err(error::invalid(format!(
                    "{id} has {} descendant(s) ({}); delete them first or pass --cascade",
                    kids.len(),
                    kids.join(", ")
                )));
            }
        }
    }
    let mut ids: Vec<String> = set.into_iter().collect();
    ids.sort_by(|x, y| {
        let depth = |s: &str| s.matches('.').count();
        depth(y).cmp(&depth(x)).then_with(|| y.cmp(x))
    });
    Ok(ids)
}

pub fn delete(store: &mut Store, a: DeleteArgs, json_out: bool) -> Result<()> {
    if !a.force || a.dry_run {
        let plan = delete_plan(store.conn(), &a)?;
        if json_out {
            print_json(&json!({ "would_delete": plan, "schema_version": 1 }))?;
        } else {
            println!("Would delete {} issue(s): {}", plan.len(), plan.join(", "));
            if !a.dry_run {
                println!("Rerun with --force to delete.");
            }
        }
        return Ok(());
    }
    let actor = Actor::resolve();
    let now = now_rfc3339();
    let deleted = store.write(|tx| {
        let plan = delete_plan(tx, &a)?;
        for id in &plan {
            let snapshot = serde_json::to_string(&issue::json(tx, id)?)?;
            tx.execute("delete from issues where id=?1", [id])?;
            Event::issue(id, "deleted")
                .old(Some(&snapshot))
                .log(tx, &actor, &now)?;
        }
        Ok(plan)
    })?;
    if json_out {
        print_json(&json!({ "deleted": deleted, "count": deleted.len(), "schema_version": 1 }))?;
    } else {
        println!("✓ Deleted {} issue(s): {}", deleted.len(), deleted.join(", "));
    }
    Ok(())
}

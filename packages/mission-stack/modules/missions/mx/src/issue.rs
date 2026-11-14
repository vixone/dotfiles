//! Issue rows and their bd-compatible JSON shape.

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Row};
use serde_json::{json, Map, Value};

use crate::error;

pub const STATUSES: &[&str] = &["open", "in_progress", "blocked", "deferred", "closed"];

pub const COLUMNS: &str = "id, title, description, design, acceptance_criteria, notes, status, priority, \
    issue_type, parent_id, assignee, owner, created_by, created_at, updated_at, started_at, \
    closed_at, close_reason, last_child";

#[derive(Clone, Debug)]
pub struct Issue {
    pub id: String,
    pub title: String,
    pub description: String,
    pub design: String,
    pub acceptance_criteria: String,
    pub notes: String,
    pub status: String,
    pub priority: i64,
    pub issue_type: String,
    pub parent_id: Option<String>,
    pub assignee: Option<String>,
    pub owner: Option<String>,
    pub created_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub started_at: Option<String>,
    pub closed_at: Option<String>,
    pub close_reason: Option<String>,
    pub last_child: i64,
}

impl Issue {
    pub fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Issue {
            id: r.get(0)?,
            title: r.get(1)?,
            description: r.get(2)?,
            design: r.get(3)?,
            acceptance_criteria: r.get(4)?,
            notes: r.get(5)?,
            status: r.get(6)?,
            priority: r.get(7)?,
            issue_type: r.get(8)?,
            parent_id: r.get(9)?,
            assignee: r.get(10)?,
            owner: r.get(11)?,
            created_by: r.get(12)?,
            created_at: r.get(13)?,
            updated_at: r.get(14)?,
            started_at: r.get(15)?,
            closed_at: r.get(16)?,
            close_reason: r.get(17)?,
            last_child: r.get(18)?,
        })
    }

    /// bd field order; empty strings and NULLs are omitted like bd's omitempty.
    pub fn to_json(&self, labels: &[String]) -> Map<String, Value> {
        fn put(m: &mut Map<String, Value>, k: &str, v: Option<&str>) {
            if let Some(v) = v.filter(|v| !v.is_empty()) {
                m.insert(k.to_string(), json!(v));
            }
        }
        let mut m = Map::new();
        put(&mut m, "id", Some(&self.id));
        put(&mut m, "title", Some(&self.title));
        put(&mut m, "description", Some(&self.description));
        put(&mut m, "design", Some(&self.design));
        put(&mut m, "acceptance_criteria", Some(&self.acceptance_criteria));
        put(&mut m, "notes", Some(&self.notes));
        put(&mut m, "status", Some(&self.status));
        m.insert("priority".into(), json!(self.priority));
        put(&mut m, "issue_type", Some(&self.issue_type));
        put(&mut m, "assignee", self.assignee.as_deref());
        put(&mut m, "owner", self.owner.as_deref());
        put(&mut m, "created_at", Some(&self.created_at));
        put(&mut m, "created_by", self.created_by.as_deref());
        put(&mut m, "updated_at", Some(&self.updated_at));
        put(&mut m, "started_at", self.started_at.as_deref());
        put(&mut m, "closed_at", self.closed_at.as_deref());
        put(&mut m, "close_reason", self.close_reason.as_deref());
        if !labels.is_empty() {
            m.insert("labels".into(), json!(labels));
        }
        m
    }
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<Issue>> {
    Ok(conn
        .query_row(&format!("select {COLUMNS} from issues where id=?1"), [id], Issue::from_row)
        .optional()?)
}

/// Like [`get`], but a missing id is exit 1.
pub fn require(conn: &Connection, id: &str) -> Result<Issue> {
    get(conn, id)?.ok_or_else(|| error::not_found(id))
}

pub fn labels(conn: &Connection, id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare_cached("select label from labels where issue_id=?1 order by label")?;
    let rows = stmt.query_map([id], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Issue JSON with labels, loaded fresh from the db.
pub fn json(conn: &Connection, id: &str) -> Result<Map<String, Value>> {
    let issue = require(conn, id)?;
    Ok(issue.to_json(&labels(conn, id)?))
}

/// Add bd's envelope field to a top-level JSON object.
pub fn with_schema_version(mut m: Map<String, Value>) -> Value {
    m.insert("schema_version".into(), json!(1));
    Value::Object(m)
}

/// Parse `0`-`4` or `P0`-`P4`.
pub fn parse_priority(raw: &str) -> Result<i64> {
    let s = raw.trim();
    let digits = s.strip_prefix(['P', 'p']).unwrap_or(s);
    match digits.parse::<i64>() {
        Ok(n) if (0..=4).contains(&n) => Ok(n),
        _ => Err(error::invalid(format!("invalid priority {raw:?}: use 0-4 or P0-P4"))),
    }
}

pub fn parse_status(raw: &str) -> Result<String> {
    let s = raw.trim().to_ascii_lowercase().replace('-', "_");
    if STATUSES.contains(&s.as_str()) {
        Ok(s)
    } else {
        Err(error::invalid(format!(
            "invalid status {raw:?}: use one of {}",
            STATUSES.join(", ")
        )))
    }
}

/// Lowercase and apply bd's type aliases.
pub fn normalize_type(raw: &str) -> String {
    let t = raw.trim().to_ascii_lowercase();
    match t.as_str() {
        "enhancement" | "feat" => "feature".into(),
        "dec" | "adr" => "decision".into(),
        _ => t,
    }
}

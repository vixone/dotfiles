//! Actor resolution and the append-only events log.

use anyhow::Result;
use rusqlite::Connection;

/// The OS user writing a new issue, comment, or event. Imported history keeps
/// its original author; new issues leave the legacy owner email unset.
#[derive(Clone, Debug)]
pub struct Actor {
    pub name: String,
}

impl Actor {
    /// `$USER`, or `unknown` when the process has no OS user name.
    pub fn resolve() -> Actor {
        let name = std::env::var("USER")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| "unknown".to_string());
        Actor { name }
    }
}

/// One events row. Build with [`Event::issue`] or [`Event::memory`] and chain
/// setters; `None` fields stay NULL.
#[derive(Default)]
pub struct Event<'a> {
    pub issue_id: Option<&'a str>,
    pub memory_key: Option<&'a str>,
    pub kind: &'a str,
    pub field: Option<&'a str>,
    pub old: Option<&'a str>,
    pub new: Option<&'a str>,
    pub reason: Option<&'a str>,
}

impl<'a> Event<'a> {
    pub fn issue(id: &'a str, kind: &'a str) -> Self {
        Event { issue_id: Some(id), kind, ..Default::default() }
    }

    pub fn memory(key: &'a str, kind: &'a str) -> Self {
        Event { memory_key: Some(key), kind, ..Default::default() }
    }

    pub fn field(mut self, f: &'a str) -> Self {
        self.field = Some(f);
        self
    }

    pub fn old(mut self, v: Option<&'a str>) -> Self {
        self.old = v;
        self
    }

    pub fn new(mut self, v: Option<&'a str>) -> Self {
        self.new = v;
        self
    }

    pub fn reason(mut self, v: Option<&'a str>) -> Self {
        self.reason = v;
        self
    }

    pub fn log(self, conn: &Connection, actor: &Actor, now: &str) -> Result<()> {
        conn.execute(
            "insert into events(issue_id, memory_key, kind, field, old_value, new_value, reason, actor, created_at)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            (
                self.issue_id,
                self.memory_key,
                self.kind,
                self.field,
                self.old,
                self.new,
                self.reason,
                &actor.name,
                now,
            ),
        )?;
        Ok(())
    }
}

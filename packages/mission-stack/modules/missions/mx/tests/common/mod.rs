#![allow(dead_code)]

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use rusqlite::Connection;
use serde_json::Value;
use tempfile::TempDir;

pub struct Out {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// A throwaway store plus helpers to drive the mx binary against it.
pub struct Env {
    _dir: TempDir,
    pub db: PathBuf,
}

impl Env {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("mx.db");
        Env { _dir: dir, db }
    }

    fn cmd(&self, args: &[&str]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_mx"));
        c.args(args)
            .env("MX_DB", &self.db)
            .env("MX_BACKUP_DIR", self.backup_dir())
            .env("USER", "tester")
            .env("MX_ACTOR", "legacy-actor")
            .env("MX_OWNER", "old@example.com")
            .env("BEADS_ACTOR", "beads-actor")
            .env("BD_ACTOR", "bd-actor");
        c
    }

    pub fn run_stdin(&self, args: &[&str], stdin: &str) -> Out {
        let mut child = self
            .cmd(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
        let o = child.wait_with_output().unwrap();
        Out {
            code: o.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
        }
    }

    pub fn run(&self, args: &[&str]) -> Out {
        self.run_stdin(args, "")
    }

    /// Run, assert exit 0, return trimmed stdout.
    pub fn ok(&self, args: &[&str]) -> String {
        let o = self.run(args);
        assert_eq!(o.code, 0, "mx {args:?} failed: {}", o.stderr);
        o.stdout.trim().to_string()
    }

    pub fn ok_stdin(&self, args: &[&str], stdin: &str) -> String {
        let o = self.run_stdin(args, stdin);
        assert_eq!(o.code, 0, "mx {args:?} failed: {}", o.stderr);
        o.stdout.trim().to_string()
    }

    pub fn json(&self, args: &[&str]) -> Value {
        let s = self.ok(args);
        serde_json::from_str(&s).unwrap_or_else(|e| panic!("mx {args:?}: bad json {e}: {s}"))
    }

    pub fn epic(&self, title: &str) -> String {
        self.ok(&["create", title, "--type", "epic", "--silent"])
    }

    pub fn child(&self, parent: &str, title: &str) -> String {
        self.ok(&["create", title, "--parent", parent, "--silent"])
    }

    pub fn backup_dir(&self) -> PathBuf {
        self.db.with_file_name("backup")
    }

    fn conn(&self) -> Connection {
        Connection::open(&self.db).unwrap()
    }

    pub fn scalar(&self, sql: &str) -> String {
        self.conn()
            .query_row(sql, [], |r| {
                let v: rusqlite::types::Value = r.get(0)?;
                Ok(match v {
                    rusqlite::types::Value::Null => "NULL".to_string(),
                    rusqlite::types::Value::Integer(i) => i.to_string(),
                    rusqlite::types::Value::Real(f) => f.to_string(),
                    rusqlite::types::Value::Text(t) => t,
                    rusqlite::types::Value::Blob(_) => "<blob>".to_string(),
                })
            })
            .unwrap()
    }

    pub fn exec(&self, sql: &str) {
        self.conn().execute_batch(sql).unwrap();
    }

    pub fn count(&self, sql: &str) -> i64 {
        self.conn().query_row(sql, [], |r| r.get(0)).unwrap()
    }

    pub fn rows(&self, sql: &str) -> Vec<String> {
        let conn = self.conn();
        let mut stmt = conn.prepare(sql).unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
        rows.map(|r| r.unwrap()).collect()
    }

    pub fn labels(&self, id: &str) -> Vec<String> {
        self.rows(&format!("select label from labels where issue_id='{id}' order by label"))
    }
}

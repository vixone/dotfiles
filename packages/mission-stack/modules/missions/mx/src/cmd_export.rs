//! `mx export`: one JSON object per issue (list row plus comments, with
//! dependency edges), then one `{"_type":"memory",key,text}` per memory.

use std::fs;
use std::io::{BufWriter, Write};
use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::Args;
use serde_json::json;

use crate::issue::{Issue, COLUMNS};
use crate::json;
use crate::store::Store;

#[derive(Args)]
pub struct ExportArgs {
    /// Output file (default: stdout). Written to a temp file, then renamed.
    #[arg(short = 'o', long)]
    pub output: Option<PathBuf>,
}

fn write_all(store: &Store, out: &mut dyn Write) -> Result<(usize, usize)> {
    let conn = store.conn();
    let mut stmt = conn.prepare(&format!("select {COLUMNS} from issues order by id"))?;
    let issues: Vec<Issue> = stmt
        .query_map([], Issue::from_row)?
        .collect::<rusqlite::Result<_>>()?;
    for obj in json::export_rows(conn, &issues)? {
        serde_json::to_writer(&mut *out, &obj)?;
        out.write_all(b"\n")?;
    }
    let mut stmt = conn.prepare("select key, text from memories order by key")?;
    let mems: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (k, t) in &mems {
        serde_json::to_writer(&mut *out, &json!({"_type": "memory", "key": k, "text": t}))?;
        out.write_all(b"\n")?;
    }
    out.flush()?;
    Ok((issues.len(), mems.len()))
}

pub fn export(store: &Store, a: ExportArgs, _json_out: bool) -> Result<()> {
    match a.output {
        None => {
            let stdout = std::io::stdout();
            let mut w = BufWriter::new(stdout.lock());
            write_all(store, &mut w)?;
        }
        Some(path) => {
            let tmp = path.with_extension("jsonl.tmp");
            let (n, m) = {
                let f = fs::File::create(&tmp).with_context(|| format!("create {}", tmp.display()))?;
                let mut w = BufWriter::new(f);
                write_all(store, &mut w)?
            };
            fs::rename(&tmp, &path).with_context(|| format!("rename to {}", path.display()))?;
            eprintln!("Exported {n} issues and {m} memories to {}", path.display());
        }
    }
    Ok(())
}

//! Memories (lessons): remember, memories, recall, forget. Events carry
//! memory_key and leave issue_id NULL.

use anyhow::Result;
use clap::Args;
use rusqlite::OptionalExtension;
use serde_json::{json, Map, Value};

use crate::error;
use crate::events::{Actor, Event};
use crate::secrets;
use crate::store::{now_rfc3339, Store};

const SLUG_WORDS: usize = 8;
const SLUG_MAX: usize = 60;

/// bd's key derivation: split on anything outside [A-Za-z0-9], take the
/// first 8 tokens, lowercase, join with '-', cap at 60 chars. "it's" is two
/// tokens (it, s), as in bd.
pub fn slug(text: &str) -> String {
    let tokens: Vec<String> = text
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .take(SLUG_WORDS)
        .map(str::to_ascii_lowercase)
        .collect();
    let joined: String = tokens.join("-").chars().take(SLUG_MAX).collect();
    joined.trim_end_matches('-').to_string()
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() > max {
        format!("{}...", text.chars().take(max - 3).collect::<String>())
    } else {
        text.to_string()
    }
}

#[derive(Args)]
pub struct RememberArgs {
    /// Lesson text; several words are joined with spaces.
    #[arg(required = true)]
    pub text: Vec<String>,
    /// Key to store under (default: slug of the first words).
    #[arg(long)]
    pub key: Option<String>,
}

pub fn remember(store: &mut Store, a: RememberArgs, _json_out: bool) -> Result<()> {
    let text = a.text.join(" ");
    if text.trim().is_empty() {
        return Err(error::usage("no text given"));
    }
    let key = match a.key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        Some(k) => k.to_string(),
        None => slug(&text),
    };
    if key.is_empty() {
        return Err(error::usage("cannot derive a key from the text; pass --key"));
    }
    secrets::check(&[("memory", &text), ("key", &key)])?;
    let actor = Actor::resolve();
    let now = now_rfc3339();
    let old: Option<String> = store.write(|tx| {
        let old: Option<String> = tx
            .query_row("select text from memories where key=?1", [&key], |r| r.get(0))
            .optional()?;
        tx.execute(
            "insert into memories(key, text, created_at, updated_at) values (?1, ?2, ?3, ?3)
             on conflict(key) do update set text=excluded.text, updated_at=excluded.updated_at",
            (&key, &text, &now),
        )?;
        Event::memory(&key, "remembered")
            .old(old.as_deref())
            .new(Some(&text))
            .log(tx, &actor, &now)?;
        Ok(old)
    })?;
    let verb = if old.is_some() { "Updated" } else { "Remembered" };
    println!("{verb} [{key}]: {}", clip(&text, 80));
    Ok(())
}

#[derive(Args)]
pub struct MemoriesArgs {
    /// Case-insensitive filter on key or text.
    pub query: Option<String>,
}

pub fn memories(store: &Store, a: MemoriesArgs, json_out: bool) -> Result<()> {
    let mut stmt = store.conn().prepare(
        "select key, text from memories
         where ?1 is null or instr(lower(key), lower(?1)) > 0 or instr(lower(text), lower(?1)) > 0
         order by key",
    )?;
    let rows: Vec<(String, String)> = stmt
        .query_map([&a.query], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    if json_out {
        let mut m = Map::new();
        m.insert("schema_version".into(), json!(1));
        for (k, t) in rows {
            m.insert(k, json!(t));
        }
        println!("{}", serde_json::to_string_pretty(&Value::Object(m))?);
        return Ok(());
    }
    if rows.is_empty() {
        println!("No memories.");
        return Ok(());
    }
    match &a.query {
        Some(q) => println!("Memories matching {q:?}:\n"),
        None => println!("Memories ({}):\n", rows.len()),
    }
    for (k, t) in rows {
        println!("  {k}\n    {}\n", clip(&t.replace('\n', " "), 120));
    }
    Ok(())
}

#[derive(Args)]
pub struct KeyArgs {
    pub key: String,
}

pub fn recall(store: &Store, a: KeyArgs, _json_out: bool) -> Result<()> {
    let text: Option<String> = store
        .conn()
        .query_row("select text from memories where key=?1", [&a.key], |r| r.get(0))
        .optional()?;
    match text {
        Some(t) => {
            println!("{t}");
            Ok(())
        }
        None => Err(error::invalid(format!("no memory with key {:?}", a.key))),
    }
}

pub fn forget(store: &mut Store, a: KeyArgs, _json_out: bool) -> Result<()> {
    let actor = Actor::resolve();
    let now = now_rfc3339();
    let text = store.write(|tx| {
        let text: Option<String> = tx
            .query_row("select text from memories where key=?1", [&a.key], |r| r.get(0))
            .optional()?;
        let Some(text) = text else {
            return Err(error::invalid(format!("no memory with key {:?}", a.key)));
        };
        tx.execute("delete from memories where key=?1", [&a.key])?;
        Event::memory(&a.key, "forgot").old(Some(&text)).log(tx, &actor, &now)?;
        Ok(text)
    })?;
    println!("Forgot [{}]: {}", a.key, clip(&text, 80));
    Ok(())
}

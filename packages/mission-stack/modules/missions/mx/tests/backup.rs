mod common;

use std::fs;

use common::Env;

fn today() -> String {
    chrono::Utc::now().format("%Y%m%d").to_string()
}

fn snapshots(env: &Env) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(env.backup_dir())
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

#[test]
fn first_write_of_day_snapshots() {
    let env = Env::new();
    assert!(snapshots(&env).is_empty());
    env.epic("A");
    let snap = format!("mx-{}.db", today());
    assert_eq!(snapshots(&env), vec![snap.clone()]);
    let first = fs::metadata(env.backup_dir().join(&snap)).unwrap().modified().unwrap();
    env.epic("B");
    assert_eq!(snapshots(&env), vec![snap.clone()]);
    let again = fs::metadata(env.backup_dir().join(&snap)).unwrap().modified().unwrap();
    assert_eq!(first, again, "second write the same day must not re-snapshot");
    assert_eq!(env.scalar("select value from meta where key='last_backup_date'"), today());
}

#[test]
fn due_backup_replaces_existing_dated_file() {
    let env = Env::new();
    env.epic("Old store");
    let snap = env.backup_dir().join(format!("mx-{}.db", today()));
    // Simulate a replaced store whose dated backup belongs to the old one.
    env.exec("delete from meta where key='last_backup_date'");
    env.epic("New store");

    let backup = rusqlite::Connection::open(&snap).unwrap();
    let n: i64 = backup.query_row("select count(*) from issues", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 2);
    assert_eq!(env.scalar("select value from meta where key='last_backup_date'"), today());
}

#[test]
fn reads_do_not_snapshot() {
    let env = Env::new();
    env.ok(&["list", "--json"]);
    assert!(snapshots(&env).is_empty());
}

#[test]
fn retention_14() {
    let env = Env::new();
    fs::create_dir_all(env.backup_dir()).unwrap();
    for d in 1..=16 {
        fs::write(env.backup_dir().join(format!("mx-202001{d:02}.db")), b"old").unwrap();
    }
    fs::write(env.backup_dir().join("keep-me.txt"), b"x").unwrap();
    env.epic("A");
    let snaps: Vec<String> = snapshots(&env).into_iter().filter(|s| s.starts_with("mx-")).collect();
    assert_eq!(snaps.len(), 14, "{snaps:?}");
    assert_eq!(snaps.last().unwrap(), &format!("mx-{}.db", today()));
    assert_eq!(snaps.first().unwrap(), "mx-20200104.db");
    assert!(env.backup_dir().join("keep-me.txt").exists(), "only mx-YYYYMMDD.db files are pruned");
}

#[test]
fn snapshot_is_valid() {
    let env = Env::new();
    let e = env.epic("A");
    env.child(&e, "c");
    // Force a second snapshot of the current state.
    env.exec("delete from meta where key='last_backup_date'");
    fs::remove_dir_all(env.backup_dir()).unwrap();
    env.ok(&["note", &e, "x"]);
    let snap = env.backup_dir().join(format!("mx-{}.db", today()));
    let conn = rusqlite::Connection::open(&snap).unwrap();
    let n: i64 = conn.query_row("select count(*) from issues", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 2);
    let ok: String = conn.query_row("pragma integrity_check", [], |r| r.get(0)).unwrap();
    assert_eq!(ok, "ok");
}

#[test]
fn backup_failure_only_warns() {
    let env = Env::new();
    // A plain file where the backup dir should be makes the snapshot fail.
    fs::write(env.backup_dir(), b"not a dir").unwrap();
    let out = env.run(&["create", "A", "--silent"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stderr.to_lowercase().contains("backup"), "{}", out.stderr);
    assert_eq!(env.count("select count(*) from issues"), 1);
}

#[test]
fn export_jsonl() {
    let env = Env::new();
    let e = env.ok(&["create", "A", "--type", "epic", "-l", "x", "--silent"]);
    let c = env.child(&e, "c");
    env.ok(&["comment", &c, "hi"]);
    let b = env.epic("B");
    env.ok(&["dep", "add", &b, &e]);
    env.ok(&["remember", "lesson text", "--key", "k1"]);
    let path = env.db.with_file_name("out.jsonl");
    env.ok(&["export", "-o", path.to_str().unwrap()]);
    let text = fs::read_to_string(&path).unwrap();
    let lines: Vec<serde_json::Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(lines.len(), 4);
    let issues: Vec<&serde_json::Value> = lines.iter().filter(|l| l.get("_type").is_none()).collect();
    assert_eq!(issues.len(), 3);
    let child = issues.iter().find(|i| i["id"] == c.as_str()).unwrap();
    assert_eq!(child["labels"], serde_json::json!(["x"]));
    assert_eq!(child["comments"][0]["text"], "hi");
    assert_eq!(child["parent"], e.as_str());
    let bj = issues.iter().find(|i| i["id"] == b.as_str()).unwrap();
    assert_eq!(bj["dependencies"][0]["depends_on_id"], e.as_str());
    assert_eq!(bj["dependencies"][0]["type"], "blocks");
    let mem = lines.last().unwrap();
    assert_eq!(mem, &serde_json::json!({"_type": "memory", "key": "k1", "text": "lesson text"}));

    let stdout = env.ok(&["export"]);
    assert_eq!(stdout.lines().count(), 4);
}

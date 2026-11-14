mod common;

use std::fs;

use common::Env;

const DUMP: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/beads-dump");

fn imported() -> Env {
    let env = Env::new();
    env.ok(&["import", "--dump-dir", DUMP]);
    env
}

#[test]
fn issues_and_parents() {
    let env = imported();
    assert_eq!(env.count("select count(*) from issues"), 6);
    let parent = |id: &str| env.scalar(&format!("select coalesce(parent_id,'NULL') from issues where id='{id}'"));
    assert_eq!(parent("mission-aaaa.1"), "mission-aaaa");
    assert_eq!(parent("mission-bbbb.1"), "mission-aaaa", "reparented child keeps its id");
    assert_eq!(parent("mission-bbbb"), "NULL");
    assert_eq!(env.count("select count(*) from deps where type not in ('blocks','relates_to')"), 0);
    assert_eq!(
        env.scalar("select updated_at from issues where id='mission-aaaa'"),
        "2026-01-02T11:00:00Z",
        "dolt timestamps become RFC3339 seconds"
    );
    assert_eq!(env.scalar("select coalesce(assignee,'NULL') from issues where id='mission-aaaa'"), "NULL");
    assert_eq!(env.scalar("select close_reason from issues where id='mission-aaaa.1'"), "Done");
    assert_eq!(env.scalar("select status from issues where id='mission-cccc'"), "deferred");
}

#[test]
fn dep_types() {
    let env = imported();
    let rows = env.rows("select issue_id||'>'||depends_on||':'||type from deps order by 1");
    assert_eq!(
        rows,
        vec![
            "mission-aaaa.2>mission-aaaa.1:blocks",
            "mission-bbbb>mission-aaaa:relates_to",
            "mission-cccc>mission-aaaa:relates_to",
            "mission-cccc>mission-bbbb:relates_to",
        ]
    );
}

#[test]
fn labels_comments_memories() {
    let env = imported();
    assert_eq!(env.count("select count(*) from labels"), 3);
    assert_eq!(env.scalar("select author||'|'||text from comments"), "jdoe|a comment");
    assert_eq!(env.rows("select key||'='||text from memories order by key"), vec!["Mixed Key=x", "lesson-one=text one"]);
    assert_eq!(env.ok(&["recall", "lesson-one"]), "text one");
}

#[test]
fn events_become_deltas() {
    let env = imported();
    assert_eq!(
        env.scalar("select new_value from events where kind='note_appended' and issue_id='mission-aaaa'"),
        "n2"
    );
    assert_eq!(
        env.scalar("select old_value||'>'||new_value from events where kind='updated' and field='title'"),
        "Old title>Alpha"
    );
    assert_eq!(env.scalar("select coalesce(old_value,'NULL')||'>'||new_value from events where field='priority'"), "NULL>1");
    assert_eq!(
        env.scalar("select old_value||'>'||new_value from events where kind='status_changed'"),
        "open>deferred",
        "snapshots reduced to the status field"
    );
    assert_eq!(env.scalar("select new_value from events where kind='claimed'"), "jdoe");
    assert_eq!(env.scalar("select reason from events where kind='closed'"), "Done");
    assert_eq!(env.scalar("select new_value from events where kind='label_added'"), "finding");
    let biggest: i64 = env.count("select max(length(coalesce(old_value,''))+length(coalesce(new_value,''))) from events");
    assert!(biggest < 100, "no snapshots survive: {biggest}");
}

#[test]
fn counters_and_meta() {
    let env = imported();
    assert_eq!(env.scalar("select last_child from issues where id='mission-aaaa'"), "3");
    assert_eq!(env.scalar("select value from meta where key='migrated_from'"), "beads-1.2.2");
    assert_eq!(env.child("mission-aaaa", "next"), "mission-aaaa.4");
    assert_eq!(env.child("mission-bbbb", "next"), "mission-bbbb.2");
}

#[test]
fn non_empty_needs_force() {
    let env = imported();
    let out = env.run(&["import", "--dump-dir", DUMP]);
    assert_eq!(out.code, 1, "{}", out.stderr);
    env.ok(&["import", "--dump-dir", DUMP, "--force"]);
    assert_eq!(env.count("select count(*) from issues"), 6);
}

#[test]
fn first_write_after_import_replaces_backup_from_previous_store() {
    let env = Env::new();
    env.epic("Old store");
    let day = chrono::Utc::now().format("%Y%m%d").to_string();
    let snap = env.backup_dir().join(format!("mx-{day}.db"));
    assert!(snap.exists());
    assert_eq!(env.scalar("select value from meta where key='last_backup_date'"), day);

    env.ok(&["import", "--dump-dir", DUMP, "--force"]);
    assert_eq!(env.count("select count(*) from issues"), 6);
    assert_eq!(env.count("select count(*) from meta where key='last_backup_date'"), 0);
    env.epic("Post-import write");

    let backup = rusqlite::Connection::open(&snap).unwrap();
    let titles: Vec<String> = {
        let mut stmt = backup.prepare("select title from issues order by title").unwrap();
        stmt.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    };
    assert_eq!(titles.len(), 7, "first post-import backup must contain the imported store");
    assert!(titles.contains(&"Alpha".to_string()));
    assert!(titles.contains(&"Post-import write".to_string()));
    assert!(!titles.contains(&"Old store".to_string()));
    assert_eq!(backup.query_row("pragma integrity_check", [], |r| r.get::<_, String>(0)).unwrap(), "ok");
    drop(backup);
    assert_eq!(env.scalar("select value from meta where key='last_backup_date'"), day);
    env.epic("Second post-import write");
    let backup = rusqlite::Connection::open(&snap).unwrap();
    let n: i64 = backup.query_row("select count(*) from issues", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 7, "later writes the same day must not re-snapshot");
    assert_eq!(fs::read_dir(env.backup_dir()).unwrap().count(), 1);
}

#[test]
fn actor_map() {
    let env = Env::new();
    env.ok(&["import", "--dump-dir", DUMP, "--map-actor", "jdoe=Jane Doe"]);
    assert_eq!(env.count("select count(*) from issues where created_by='jdoe'"), 0);
    assert_eq!(env.scalar("select assignee from issues where id='mission-aaaa.2'"), "Jane Doe");
    assert_eq!(env.scalar("select author from comments"), "Jane Doe");
    assert_eq!(env.count("select count(*) from events where actor='jdoe'"), 0);
}

#[test]
fn import_reports_counts_json() {
    let env = Env::new();
    let v = env.json(&["import", "--dump-dir", DUMP, "--json"]);
    assert_eq!(v["issues"], 6);
    assert_eq!(v["deps"], 4);
    assert_eq!(v["memories"], 2);
    assert_eq!(v["fk_violations"], 0);
    assert_eq!(v["skipped_deps"], 1);
}

mod common;

use common::Env;
use serde_json::Value;

#[test]
fn create_epic_id_shape() {
    let env = Env::new();
    let id = env.ok(&["create", "T", "--type", "epic", "--silent"]);
    let re = regex::Regex::new(r"^mission-[0-9a-z]{4}$").unwrap();
    assert!(re.is_match(&id), "bad epic id {id:?}");
}

#[test]
fn create_title_flag_and_priority_forms() {
    let env = Env::new();
    let id = env.ok(&["create", "--title", "Flag title", "-p", "P1", "--silent"]);
    assert_eq!(env.scalar(&format!("select title from issues where id='{id}'")), "Flag title");
    assert_eq!(env.scalar(&format!("select priority from issues where id='{id}'")), "1");
    let out = env.run(&["create", "Bad", "-p", "7"]);
    assert_eq!(out.code, 1, "{}", out.stderr);
}

#[test]
fn child_ids_monotonic() {
    let env = Env::new();
    let e = env.epic("E");
    assert_eq!(env.child(&e, "c1"), format!("{e}.1"));
    let c2 = env.child(&e, "c2");
    assert_eq!(c2, format!("{e}.2"));
    env.ok(&["delete", &c2, "--force"]);
    assert_eq!(env.child(&e, "c3"), format!("{e}.3"));
    assert_eq!(env.child(&format!("{e}.1"), "g1"), format!("{e}.1.1"));
}

#[test]
fn create_missing_parent_exits_1() {
    let env = Env::new();
    let out = env.run(&["create", "orphan", "--parent", "mission-zzzz"]);
    assert_eq!(out.code, 1);
    assert!(out.stderr.contains("mission-zzzz"), "{}", out.stderr);
}

#[test]
fn create_json_is_object() {
    let env = Env::new();
    let v: Value = env.json(&["create", "J", "--labels", "x", "--json"]);
    let obj = v.as_object().expect("create --json must be an object");
    assert!(obj["id"].as_str().unwrap().starts_with("mission-"));
    assert_eq!(obj["title"], "J");
    assert_eq!(obj["status"], "open");
    assert_eq!(obj["issue_type"], "task");
    assert_eq!(obj["priority"], 2);
    assert_eq!(obj["created_by"], "tester");
    assert_eq!(obj["labels"], serde_json::json!(["x"]));
}

#[test]
fn os_user_is_actor_even_with_legacy_overrides() {
    let env = Env::new();
    let v = env.json(&["create", "Attribution", "--type", "epic", "--json"]);
    let id = v["id"].as_str().unwrap();
    assert_eq!(v["created_by"], "tester");
    assert!(v["owner"].is_null(), "new issues do not inherit git owner email");

    env.ok(&["update", id, "--claim"]);
    env.ok(&["comment", id, "comment author"]);
    assert_eq!(env.scalar(&format!("select assignee from issues where id='{id}'")), "tester");
    assert_eq!(env.scalar(&format!("select author from comments where issue_id='{id}'")), "tester");
    assert_eq!(env.count(&format!("select count(*) from events where issue_id='{id}' and actor<>'tester'")), 0);
}

#[test]
fn closed_issue_can_migrate_old_assignee_without_rewriting_history() {
    let env = Env::new();
    let id = env.epic("Old claim");
    env.ok(&["update", &id, "--assignee", "Jane Doe"]);
    env.ok(&["close", &id]);
    env.ok(&["update", &id, "--assignee", "tester"]);

    assert_eq!(env.scalar(&format!("select status from issues where id='{id}'")), "closed");
    assert_eq!(env.scalar(&format!("select assignee from issues where id='{id}'")), "tester");
    assert_eq!(
        env.scalar(&format!("select old_value||'>'||new_value from events where issue_id='{id}' and field='assignee' order by id desc limit 1")),
        "Jane Doe>tester"
    );
    assert_eq!(env.scalar(&format!("select actor from events where issue_id='{id}' and field='assignee' order by id desc limit 1")), "tester");
}

#[test]
fn labels_inherit() {
    let env = Env::new();
    let e = env.ok(&["create", "E", "--type", "epic", "--labels", "p1,p2", "--silent"]);
    let c = env.ok(&["create", "c", "--parent", &e, "--labels", "a,b", "--silent"]);
    assert_eq!(env.labels(&c), vec!["a", "b", "p1", "p2"]);
    let n = env.ok(&["create", "n", "--parent", &e, "--no-inherit-labels", "-l", "z", "--silent"]);
    assert_eq!(env.labels(&n), vec!["z"]);
}

#[test]
fn update_claim_json_is_array() {
    let env = Env::new();
    let id = env.epic("E");
    let v = env.json(&["update", &id, "--claim", "--json"]);
    let arr = v.as_array().expect("update --json must be an array");
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["id"], id.as_str());
    assert_eq!(arr[0]["status"], "in_progress");
    assert_eq!(arr[0]["assignee"], "tester");
    assert!(arr[0]["started_at"].is_string());
    assert_eq!(env.count(&format!("select count(*) from events where issue_id='{id}' and kind='claimed'")), 1);
}

#[test]
fn update_fields() {
    let env = Env::new();
    let e = env.epic("E");
    let other = env.epic("Other");
    let c = env.child(&e, "c");

    env.ok(&["update", &c, "--status", "blocked", "--title", "New", "-d", "desc", "-p", "0"]);
    assert_eq!(env.scalar(&format!("select status||'|'||title||'|'||description||'|'||priority from issues where id='{c}'")), "blocked|New|desc|0");
    let out = env.run(&["update", &c, "--status", "bogus"]);
    assert_eq!(out.code, 1, "{}", out.stderr);

    env.ok(&["update", &c, "--parent", &other]);
    assert_eq!(env.scalar(&format!("select parent_id from issues where id='{c}'")), other);
    env.ok(&["update", &c, "--parent", ""]);
    assert_eq!(env.scalar(&format!("select coalesce(parent_id,'NULL') from issues where id='{c}'")), "NULL");

    env.ok(&["update", &c, "--design", "d1"]);
    assert_eq!(env.scalar(&format!("select design from issues where id='{c}'")), "d1");
    env.ok_stdin(&["update", &c, "--design-file", "-"], "line1\nline2\n");
    assert_eq!(env.scalar(&format!("select design from issues where id='{c}'")), "line1\nline2\n");

    env.ok(&["update", &c, "--add-label", "a,b", "--add-label", "c"]);
    assert_eq!(env.labels(&c), vec!["a", "b", "c"]);
    env.ok(&["update", &c, "--remove-label", "b"]);
    assert_eq!(env.labels(&c), vec!["a", "c"]);
    env.ok(&["update", &c, "--set-labels", "x,y"]);
    assert_eq!(env.labels(&c), vec!["x", "y"]);

    let n = env.count(&format!("select count(*) from events where issue_id='{c}' and kind='updated' and field='title'"));
    assert_eq!(n, 1);
    assert_eq!(env.count(&format!("select count(*) from events where issue_id='{c}' and kind='status_changed'")), 1);
    let bumped = env.scalar(&format!("select updated_at >= created_at from issues where id='{c}'"));
    assert_eq!(bumped, "1");
}

#[test]
fn update_missing_issue_exits_1() {
    let env = Env::new();
    let out = env.run(&["update", "mission-zzzz", "--title", "x"]);
    assert_eq!(out.code, 1);
}

#[test]
fn note_appends() {
    let env = Env::new();
    let id = env.epic("E");
    env.ok(&["note", &id, "a"]);
    env.ok(&["note", &id, "b"]);
    assert_eq!(env.scalar(&format!("select notes from issues where id='{id}'")), "a\nb");
    let deltas = env.rows(&format!(
        "select new_value from events where issue_id='{id}' and kind='note_appended' order by id"
    ));
    assert_eq!(deltas, vec!["a", "b"]);
    env.ok(&["note", &id, "multi", "word"]);
    env.ok_stdin(&["note", &id, "--stdin"], "piped\n");
    assert_eq!(env.scalar(&format!("select notes from issues where id='{id}'")), "a\nb\nmulti word\npiped");
}

#[test]
fn comment_row() {
    let env = Env::new();
    let id = env.epic("E");
    let v = env.json(&["comment", &id, "hello", "--json"]);
    assert_eq!(v["text"], "hello");
    assert_eq!(v["issue_id"], id.as_str());
    assert_eq!(env.scalar(&format!("select author||'|'||text from comments where issue_id='{id}'")), "tester|hello");
    assert_eq!(env.count(&format!("select count(*) from events where issue_id='{id}' and kind='commented'")), 1);
}

#[test]
fn dep_add_direction() {
    let env = Env::new();
    let x = env.epic("X");
    let y = env.epic("Y");
    env.ok(&["dep", "add", &x, &y]);
    assert_eq!(env.count(&format!("select count(*) from deps where issue_id='{x}' and depends_on='{y}' and type='blocks'")), 1);
    env.ok(&["link", &x, &y, "--type", "relates_to"]);
    assert_eq!(env.count(&format!("select count(*) from deps where issue_id='{x}' and depends_on='{y}' and type='relates_to'")), 1);
    let out = env.run(&["link", &x, &y, "--type", "tracks"]);
    assert_eq!(out.code, 2, "{}", out.stderr);
    let out = env.run(&["dep", "add", &y, &x]);
    assert_eq!(out.code, 1, "cycle must be refused: {}", out.stderr);
    assert_eq!(env.count("select count(*) from events where kind='dep_added'"), 2);
}

#[test]
fn delete_needs_force_and_refuses_children() {
    let env = Env::new();
    let e = env.epic("E");
    let c = env.child(&e, "c");
    env.ok(&["delete", &c]);
    assert_eq!(env.count(&format!("select count(*) from issues where id='{c}'")), 1);
    let out = env.run(&["delete", &e, "--force"]);
    assert_eq!(out.code, 1, "{}", out.stderr);
    env.ok(&["delete", &e, "--force", "--cascade"]);
    assert_eq!(env.count("select count(*) from issues"), 0);
    assert_eq!(env.count("select count(*) from events where kind='deleted'"), 2);
}

#[test]
fn secret_refused() {
    let env = Env::new();
    let id = env.epic("E");
    let key = "AKIAABCDEFGHIJKLMNOP";
    let before = env.count("select count(*) from events");
    for args in [
        vec!["create", "leak", "-d", key],
        vec!["update", &id, "--design", key],
        vec!["note", &id, key],
        vec!["comment", &id, key],
    ] {
        let out = env.run(&args);
        assert_eq!(out.code, 3, "{args:?}: {}", out.stderr);
        assert!(out.stderr.contains("AWS access key ID"), "{}", out.stderr);
        assert!(!out.stderr.contains(key), "secret must not be echoed");
    }
    assert_eq!(env.count("select count(*) from events"), before);
    assert_eq!(env.count("select count(*) from issues"), 1);
    assert_eq!(env.count("select count(*) from comments"), 0);
    // Placeholders pass.
    env.ok(&["note", &id, "set AWS_ACCESS_KEY_ID=<YOUR_KEY> first"]);
}

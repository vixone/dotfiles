mod common;

use common::Env;

fn status(env: &Env, id: &str) -> String {
    env.scalar(&format!("select status from issues where id='{id}'"))
}

#[test]
fn close_batch_topo() {
    let env = Env::new();
    let c = env.epic("C");
    let a = env.epic("A");
    env.ok(&["dep", "add", &c, &a]);
    env.ok(&["close", &c, &a]);
    assert_eq!(status(&env, &a), "closed");
    assert_eq!(status(&env, &c), "closed");
    let order = env.rows("select issue_id from events where kind='closed' order by id");
    assert_eq!(order, vec![a, c]);
}

#[test]
fn close_blocked_by_outside() {
    let env = Env::new();
    let c = env.epic("C");
    let a = env.epic("A");
    let b = env.epic("B");
    env.ok(&["dep", "add", &c, &b]);
    let out = env.run(&["close", &c, &a]);
    assert_eq!(out.code, 1, "{}", out.stderr);
    assert!(
        out.stderr.contains(&format!("cannot close {c}: blocked by open issues [{b}]")),
        "{}",
        out.stderr
    );
    assert_eq!(status(&env, &a), "closed");
    assert_eq!(status(&env, &c), "open");
}

#[test]
fn epic_open_children() {
    let env = Env::new();
    let e = env.epic("E");
    env.child(&e, "c");
    let out = env.run(&["close", &e]);
    assert_eq!(out.code, 1);
    assert!(
        out.stderr.contains(&format!(
            "cannot close epic {e}: 1 open child issue(s); close children first or use --force"
        )),
        "{}",
        out.stderr
    );
    assert_eq!(status(&env, &e), "open");
    env.ok(&["close", &e, "--force"]);
    assert_eq!(status(&env, &e), "closed");
}

#[test]
fn batch_including_children() {
    let env = Env::new();
    let e = env.epic("E");
    let c = env.child(&e, "c");
    env.ok(&["close", &e, &c]);
    assert_eq!(status(&env, &e), "closed");
    assert_eq!(status(&env, &c), "closed");
}

#[test]
fn reason_stored() {
    let env = Env::new();
    let a = env.epic("A");
    let b = env.epic("B");
    env.ok(&["close", &a, "--reason", "done it"]);
    assert_eq!(
        env.scalar(&format!("select close_reason||'|'||(closed_at is not null) from issues where id='{a}'")),
        "done it|1"
    );
    assert_eq!(
        env.scalar(&format!("select reason from events where issue_id='{a}' and kind='closed'")),
        "done it"
    );
    env.ok(&["close", &b]);
    assert_eq!(env.scalar(&format!("select close_reason from issues where id='{b}'")), "Closed");
}

#[test]
fn reasons_map_positionally() {
    let env = Env::new();
    let a = env.epic("A");
    let b = env.epic("B");
    env.ok(&["close", &a, &b, "-r", "ra", "-r", "rb"]);
    assert_eq!(env.scalar(&format!("select close_reason from issues where id='{a}'")), "ra");
    assert_eq!(env.scalar(&format!("select close_reason from issues where id='{b}'")), "rb");
    let c = env.epic("C");
    let d = env.epic("D");
    let e = env.epic("E");
    let out = env.run(&["close", &c, &d, &e, "-r", "x", "-r", "y"]);
    assert_eq!(out.code, 2, "{}", out.stderr);
}

#[test]
fn reopen() {
    let env = Env::new();
    let a = env.epic("A");
    env.ok(&["close", &a, "-r", "x"]);
    env.ok(&["reopen", &a, "-r", "again"]);
    assert_eq!(
        env.scalar(&format!(
            "select status||'|'||coalesce(closed_at,'NULL')||'|'||coalesce(close_reason,'NULL') from issues where id='{a}'"
        )),
        "open|NULL|NULL"
    );
    assert_eq!(
        env.scalar(&format!("select reason from events where issue_id='{a}' and kind='reopened'")),
        "again"
    );
    let out = env.run(&["reopen", &a]);
    assert_eq!(out.code, 1, "reopening an open issue is refused");
}

#[test]
fn close_json_is_array() {
    let env = Env::new();
    let a = env.epic("A");
    let b = env.epic("B");
    let v = env.json(&["close", &a, &b, "--json"]);
    let arr = v.as_array().expect("array");
    assert_eq!(arr.len(), 2);
    assert!(arr.iter().all(|i| i["status"] == "closed"));
}

#[test]
fn close_already_closed_is_noop() {
    let env = Env::new();
    let a = env.epic("A");
    env.ok(&["close", &a, "-r", "first"]);
    env.ok(&["close", &a, "-r", "second"]);
    assert_eq!(env.scalar(&format!("select close_reason from issues where id='{a}'")), "first");
    assert_eq!(env.count("select count(*) from events where kind='closed'"), 1);
}

#[test]
fn update_status_closed_uses_close_checks() {
    let env = Env::new();
    let e = env.epic("E");
    let c = env.child(&e, "c");
    let out = env.run(&["update", &e, "--status", "closed"]);
    assert_eq!(out.code, 1, "{}", out.stderr);
    env.ok(&["update", &c, "--status", "closed"]);
    assert_eq!(env.scalar(&format!("select close_reason from issues where id='{c}'")), "Closed");
    assert_eq!(env.count(&format!("select count(*) from events where issue_id='{c}' and kind='closed'")), 1);
}

#[test]
fn close_missing_id_exits_1_but_closes_rest() {
    let env = Env::new();
    let a = env.epic("A");
    let out = env.run(&["close", "mission-zzzz", &a]);
    assert_eq!(out.code, 1);
    assert_eq!(status(&env, &a), "closed");
}

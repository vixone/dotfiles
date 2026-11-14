mod common;

use common::Env;
use serde_json::Value;

/// E1 (epic, P1, label alpha)
///   E1.1 open          <- T is blocked by it
///     E1.1.1 open
///   E1.2 closed
///   E1.3 in_progress (claimed)
/// E2 (epic, P2) open, E3 (epic) closed, T task open blocked by E1.1
struct Seed {
    env: Env,
    e1: String,
    e2: String,
    e3: String,
    t: String,
}

impl Seed {
    fn new() -> Self {
        let env = Env::new();
        let e1 = env.ok(&["create", "Alpha epic", "--type", "epic", "-p", "1", "-l", "alpha", "--silent"]);
        let c1 = env.child(&e1, "first child");
        env.child(&c1, "grandchild");
        let c2 = env.child(&e1, "second child");
        env.ok(&["close", &c2]);
        let c3 = env.child(&e1, "third child");
        env.ok(&["update", &c3, "--claim"]);
        let e2 = env.ok(&["create", "Beta epic", "--type", "epic", "--silent"]);
        let e3 = env.ok(&["create", "Gamma epic", "--type", "epic", "--silent"]);
        env.ok(&["close", &e3]);
        let t = env.ok(&["create", "Loose task", "--silent"]);
        env.ok(&["dep", "add", &t, &c1]);
        env.ok(&["comment", &e1, "hello there"]);
        Seed { env, e1, e2, e3, t }
    }

    fn ids(&self, args: &[&str]) -> Vec<String> {
        let v = self.env.json(args);
        v.as_array()
            .unwrap_or_else(|| panic!("{args:?}: not an array: {v}"))
            .iter()
            .map(|r| r["id"].as_str().unwrap().to_string())
            .collect()
    }
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

#[test]
fn list_filters_and_shape() {
    let s = Seed::new();
    let e1 = &s.e1;
    let epics = s.ids(&["list", "--type", "epic", "--status", "open,in_progress", "--limit", "0", "--json"]);
    assert_eq!(epics, vec![e1.clone(), s.e2.clone()], "priority first");

    let all = s.ids(&["list", "--type", "epic", "--all", "--json"]);
    assert_eq!(sorted(all), sorted(vec![e1.clone(), s.e2.clone(), s.e3.clone()]));

    let default = s.ids(&["list", "--json"]);
    assert_eq!(default.len(), 6, "closed excluded by default: {default:?}");
    let labelled = s.ids(&["list", "--label", "alpha", "--json"]);
    assert_eq!(labelled.len(), 4, "children inherit alpha: {labelled:?}");
    assert_eq!(s.ids(&["list", "-n", "2", "--json"]).len(), 2);

    let v = s.env.json(&["list", "--all", "--json"]);
    let row = v.as_array().unwrap().iter().find(|r| r["id"] == format!("{e1}.1")).unwrap();
    for k in ["id", "title", "status", "priority", "issue_type", "created_at", "updated_at", "parent", "labels"] {
        assert!(row.get(k).is_some(), "missing {k} in {row}");
    }
    assert_eq!(row["parent"], e1.as_str());
    assert_eq!(row["labels"], serde_json::json!(["alpha"]));
    assert_eq!(row["dependency_count"], 1, "parent-child edge counts");
    assert_eq!(row["dependent_count"], 2, "grandchild + blocked task");
    let epic = v.as_array().unwrap().iter().find(|r| r["id"] == e1.as_str()).unwrap();
    assert_eq!(epic["comment_count"], 1);
    assert!(epic.get("parent").is_none());
}

#[test]
fn show_json_wraps_array() {
    let s = Seed::new();
    let id = format!("{}.1", s.e1);
    let v = s.env.json(&["show", &id, "--json"]);
    let arr = v.as_array().expect("show --json is an array");
    assert_eq!(arr.len(), 1);
    let row = &arr[0];
    assert_eq!(row["id"], id.as_str());
    assert_eq!(row["parent"], s.e1.as_str());
    let deps = row["dependencies"].as_array().unwrap();
    assert_eq!(deps.len(), 1);
    assert_eq!(deps[0]["id"], s.e1.as_str());
    assert_eq!(deps[0]["dependency_type"], "parent-child");
    assert_eq!(deps[0]["title"], "Alpha epic");

    let t = s.env.json(&["show", &s.t, "--json"]);
    assert_eq!(t[0]["dependencies"][0]["dependency_type"], "blocks");

    let with = s.env.json(&["show", &s.e1, "--include-comments", "--json"]);
    let c = &with[0]["comments"][0];
    assert_eq!(c["author"], "tester");
    assert_eq!(c["text"], "hello there");
    assert!(c["created_at"].is_string());
    let without = s.env.json(&["show", &s.e1, "--json"]);
    assert!(without[0].get("comments").is_none());

    assert_eq!(s.env.run(&["show", "mission-zzzz", "--json"]).code, 1);
    assert_eq!(s.env.run(&["show", "mission-zzzz"]).code, 1);
    let text = s.env.ok(&["show", &s.e1]);
    assert!(text.contains("Alpha epic") && text.contains(&s.e1), "{text}");
}

#[test]
fn show_compact_deps_omits_large_parent_body_without_changing_primary_issue() {
    let s = Seed::new();
    let child = format!("{}.1", s.e1);
    let parent_notes = "large parent notes ".repeat(4000);
    s.env.ok(&["update", &s.e1, "--notes", &parent_notes]);
    s.env.ok(&["update", &child, "--description", "Keep this child's own description"]);
    s.env.ok(&["comment", &child, "latest child comment"]);

    let full = s.env.json(&["show", &child, "--json"]);
    assert_eq!(full[0]["dependencies"][0]["notes"], parent_notes);
    let compact_raw = s.env.ok(&["show", &child, "--compact-deps", "--json"]);
    assert!(compact_raw.len() < 50_000, "compact output is {} bytes", compact_raw.len());
    let compact: Value = serde_json::from_str(&compact_raw).unwrap();
    assert_eq!(compact[0]["description"], "Keep this child's own description");
    assert_eq!(compact[0]["comment_count"], 1);
    assert_eq!(compact[0]["dependency_count"], 1);
    let parent = &compact[0]["dependencies"][0];
    assert_eq!(parent["id"], s.e1);
    assert_eq!(parent["title"], "Alpha epic");
    assert_eq!(parent["status"], "open");
    assert_eq!(parent["priority"], 1);
    assert_eq!(parent["dependency_type"], "parent-child");
    assert_eq!(parent.as_object().unwrap().len(), 5, "compact dependency must not contain parent notes");
    assert!(compact[0].get("comments").is_none());

    let with_comments = s.env.json(&["show", &child, "--compact-deps", "--include-comments", "--json"]);
    assert_eq!(with_comments[0]["comments"][0]["text"], "latest child comment");
    assert_eq!(with_comments[0]["dependencies"][0], *parent);

    let multi = s.env.json(&["show", &child, &s.t, "--compact-deps", "--json"]);
    assert_eq!(multi.as_array().unwrap().len(), 2);
    assert_eq!(multi[1]["dependencies"][0]["dependency_type"], "blocks");
    assert_eq!(multi[1]["dependencies"][0].as_object().unwrap().len(), 5);
    assert_eq!(s.env.ok(&["show", &child, "--compact-deps"]), s.env.ok(&["show", &child]));
}

#[test]
fn children_direct_in_numeric_order() {
    let s = Seed::new();
    let e = &s.e1;
    let more: Vec<String> = (0..9).map(|i| s.env.child(e, &format!("extra {i}"))).collect();
    let kids = s.ids(&["children", e, "--json"]);
    let mut want = vec![format!("{e}.1"), format!("{e}.2"), format!("{e}.3")];
    want.extend(more);
    assert_eq!(kids, want, "{e}.10 sorts after {e}.9");
    assert_eq!(s.env.run(&["children", "mission-zzzz", "--json"]).code, 1);
}

#[test]
fn ready_semantics() {
    let s = Seed::new();
    let e = &s.e1;
    let ready = sorted(s.ids(&["ready", "--json"]));
    let want = sorted(vec![e.clone(), format!("{e}.1"), format!("{e}.1.1"), s.e2.clone()]);
    assert_eq!(ready, want, "T is blocked, .2 closed, .3 in_progress");

    let under = sorted(s.ids(&["ready", "--parent", e, "--json"]));
    assert_eq!(under, sorted(vec![format!("{e}.1"), format!("{e}.1.1")]));
    assert_eq!(s.ids(&["ready", "--label", "alpha", "--json"]).len(), 3);
    s.env.ok(&["update", &format!("{e}.1"), "-a", "someone"]);
    assert_eq!(s.ids(&["ready", "--parent", e, "--unassigned", "--json"]), vec![format!("{e}.1.1")]);

    s.env.ok(&["close", &format!("{e}.1.1"), &format!("{e}.1")]);
    assert!(s.ids(&["ready", "--json"]).contains(&s.t), "unblocked once E1.1 closed");
}

#[test]
fn search_title_or_id() {
    let s = Seed::new();
    let hits = sorted(s.ids(&["search", "EPIC", "--json"]));
    assert_eq!(hits, sorted(vec![s.e1.clone(), s.e2.clone()]), "closed excluded");
    let all = s.ids(&["search", "epic", "--status", "all", "--json"]);
    assert_eq!(all.len(), 3);
    let by_id = s.ids(&["search", &format!("{}.1", s.e1), "--json"]);
    assert_eq!(by_id.len(), 2, ".1 and .1.1: {by_id:?}");
    let typed = s.ids(&["search", "child", "--type", "epic", "--json"]);
    assert!(typed.is_empty());
    assert_eq!(s.ids(&["search", "child", "--status", "closed", "--json"]).len(), 1);
}

#[test]
fn history_in_order() {
    let s = Seed::new();
    let v = s.env.json(&["history", &s.e1, "--json"]);
    let kinds: Vec<&str> = v.as_array().unwrap().iter().map(|e| e["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, vec!["created", "commented"]);
    assert_eq!(v[0]["actor"], "tester");
}

#[test]
fn human_lines() {
    let s = Seed::new();
    let out = s.env.ok(&["list", "--type", "epic"]);
    let first = out.lines().next().unwrap();
    assert_eq!(first, format!("{} [open] Alpha epic", s.e1));
    let kids = s.env.ok(&["children", &s.e1]);
    assert_eq!(kids.lines().count(), 3);
    assert!(kids.contains(&format!("{}.2 [closed] second child", s.e1)));
    let ready = s.env.ok(&["ready"]);
    assert!(ready.lines().all(|l| l.contains(" [open] ")), "{ready}");
}

#[test]
fn reads_do_not_write() {
    let s = Seed::new();
    let before = s.env.count("select count(*) from events");
    s.env.ok(&["list", "--all", "--json"]);
    s.env.ok(&["show", &s.e1, "--json"]);
    s.env.ok(&["ready", "--json"]);
    assert_eq!(s.env.count("select count(*) from events"), before);
    let _: Value = s.env.json(&["search", "x", "--json"]);
}

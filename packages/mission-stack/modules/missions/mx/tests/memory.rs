mod common;

use common::Env;

#[test]
fn remember_key() {
    let env = Env::new();
    assert_eq!(env.ok(&["remember", "text one", "--key", "k"]), "Remembered [k]: text one");
    env.exec("update memories set created_at='2020-01-01T00:00:00Z' where key='k'");
    assert_eq!(env.ok(&["remember", "text two", "--key", "k"]), "Updated [k]: text two");
    assert_eq!(env.scalar("select text from memories where key='k'"), "text two");
    assert_eq!(env.scalar("select created_at from memories where key='k'"), "2020-01-01T00:00:00Z");
    let kinds = env.rows("select kind||':'||memory_key||':'||coalesce(issue_id,'NULL') from events order by id");
    assert_eq!(kinds, vec!["remembered:k:NULL", "remembered:k:NULL"]);
    assert_eq!(env.scalar("select old_value from events where id=2"), "text one");
}

#[test]
fn remember_long_text_is_truncated_in_message() {
    let env = Env::new();
    let text = "x".repeat(100);
    let out = env.ok(&["remember", &text, "--key", "long"]);
    assert_eq!(out, format!("Remembered [long]: {}...", "x".repeat(77)));
}

#[test]
fn remember_slug() {
    let env = Env::new();
    for (text, key) in [
        ("Some Lesson About Things here", "some-lesson-about-things-here"),
        ("aa bb cc dd ee ff gg hh ii jj kk ll", "aa-bb-cc-dd-ee-ff-gg-hh"),
        ("Use the RDS Proxy: it's 3x faster!! than direct", "use-the-rds-proxy-it-s-3x-faster"),
        ("one two three four five six seven eight nine", "one-two-three-four-five-six-seven-eight"),
        ("  --Hello,   World!!  ünïcode  ", "hello-world-n-code"),
    ] {
        let out = env.ok(&["remember", text]);
        assert!(out.starts_with(&format!("Remembered [{key}]: ")), "{text:?} -> {out}");
    }
    let long = format!("{} tail", "a".repeat(80));
    let out = env.ok(&["remember", &long]);
    assert!(out.starts_with(&format!("Remembered [{}]", "a".repeat(60))), "{out}");
    assert_eq!(env.run(&["remember", "!!! ???"]).code, 2, "no slug possible");
}

#[test]
fn memories_json_map() {
    let env = Env::new();
    env.ok(&["remember", "alpha body", "--key", "a-key"]);
    env.ok(&["remember", "beta body mentions RDS", "--key", "b-key"]);
    let v = env.json(&["memories", "--json"]);
    let obj = v.as_object().expect("memories --json is an object");
    assert_eq!(obj["schema_version"], 1);
    assert_eq!(obj["a-key"], "alpha body");
    assert_eq!(obj["b-key"], "beta body mentions RDS");
    assert_eq!(obj.len(), 3);

    let text = env.ok(&["memories"]);
    assert!(text.contains("a-key") && text.contains("alpha body"), "{text}");
    let filtered = env.ok(&["memories", "rds"]);
    assert!(filtered.contains("b-key") && !filtered.contains("a-key"), "{filtered}");
    let by_key = env.json(&["memories", "A-KEY", "--json"]);
    assert_eq!(by_key.as_object().unwrap().len(), 2);
}

#[test]
fn recall() {
    let env = Env::new();
    env.ok(&["remember", "line one\nline two", "--key", "k"]);
    let out = env.run(&["recall", "k"]);
    assert_eq!(out.code, 0);
    assert_eq!(out.stdout, "line one\nline two\n");
    let missing = env.run(&["recall", "nope"]);
    assert_eq!(missing.code, 1);
    assert_eq!(missing.stdout, "");
}

#[test]
fn forget() {
    let env = Env::new();
    env.ok(&["remember", "bye", "--key", "k"]);
    assert_eq!(env.ok(&["forget", "k"]), "Forgot [k]: bye");
    assert_eq!(env.count("select count(*) from memories"), 0);
    assert_eq!(env.scalar("select old_value from events where kind='forgot' and memory_key='k'"), "bye");
    assert_eq!(env.run(&["forget", "k"]).code, 1);
}

#[test]
fn remember_secret_refused() {
    let env = Env::new();
    let out = env.run(&["remember", "key AKIAABCDEFGHIJKLMNOP", "--key", "k"]);
    assert_eq!(out.code, 3, "{}", out.stderr);
    assert_eq!(env.count("select count(*) from memories"), 0);
}

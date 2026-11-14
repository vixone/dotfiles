use mx::store::Store;
use tempfile::TempDir;

fn tmp_db() -> (TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mx.db");
    (dir, path)
}

#[test]
fn open_creates_schema_v1() {
    let (_dir, path) = tmp_db();
    let store = Store::open(&path).unwrap();
    assert!(path.exists());

    let conn = store.conn();
    let version: String = conn
        .query_row("select value from meta where key='schema_version'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, "1");

    let mode: String = conn.query_row("pragma journal_mode", [], |r| r.get(0)).unwrap();
    assert_eq!(mode, "wal");

    let fk: i64 = conn.query_row("pragma foreign_keys", [], |r| r.get(0)).unwrap();
    assert_eq!(fk, 1);
}

#[test]
fn open_is_idempotent() {
    let (_dir, path) = tmp_db();
    drop(Store::open(&path).unwrap());
    let store = Store::open(&path).unwrap();
    let n: i64 = store
        .conn()
        .query_row("select count(*) from meta where key='schema_version'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);
}

#[test]
fn open_rejects_newer_schema() {
    let (_dir, path) = tmp_db();
    {
        let store = Store::open(&path).unwrap();
        store
            .conn()
            .execute("update meta set value='99' where key='schema_version'", [])
            .unwrap();
    }
    let err = Store::open(&path).err().expect("newer schema must be rejected");
    assert!(
        format!("{err:#}").contains("schema_version 99"),
        "unexpected error: {err:#}"
    );
}

#[test]
fn write_commits_and_rolls_back() {
    let (_dir, path) = tmp_db();
    let mut store = Store::open(&path).unwrap();
    store
        .write(|tx| {
            tx.execute("insert into meta(key, value) values('k1', 'v1')", [])?;
            Ok(())
        })
        .unwrap();
    let failed: anyhow::Result<()> = store.write(|tx| {
        tx.execute("insert into meta(key, value) values('k2', 'v2')", [])?;
        anyhow::bail!("boom")
    });
    assert!(failed.is_err());

    let keys: Vec<String> = {
        let conn = store.conn();
        let mut stmt = conn
            .prepare("select key from meta where key in ('k1','k2') order by key")
            .unwrap();
        stmt.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    };
    assert_eq!(keys, vec!["k1".to_string()]);
}

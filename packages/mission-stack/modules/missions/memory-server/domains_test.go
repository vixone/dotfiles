package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mustRegistry(t *testing.T, data string) *DomainRegistry {
	t.Helper()
	reg, err := ParseDomainRegistry([]byte(data))
	if err != nil {
		t.Fatalf("ParseDomainRegistry: %v", err)
	}
	return reg
}

func TestParseDomainRegistry_RejectsInvalid(t *testing.T) {
	cases := map[string]string{
		"empty input":       ``,
		"missing version":   `{"domains":[{"prefix":"a-","domain":"a"}]}`,
		"wrong version":     `{"version":2,"domains":[{"prefix":"a-","domain":"a"}]}`,
		"unknown top field": `{"version":1,"extra":true,"domains":[{"prefix":"a-","domain":"a"}]}`,
		"unknown entry":     `{"version":1,"domains":[{"prefix":"a-","domain":"a","x":1}]}`,
		"trailing input":    `{"version":1,"domains":[{"prefix":"a-","domain":"a"}]} {}`,
		"trailing garbage":  `{"version":1,"domains":[{"prefix":"a-","domain":"a"}]} x`,
		"empty domains":     `{"version":1,"domains":[]}`,
		"null domains":      `{"version":1,"domains":null}`,
		"blank prefix":      `{"version":1,"domains":[{"prefix":"","domain":"a"}]}`,
		"blank domain":      `{"version":1,"domains":[{"prefix":"a-","domain":" "}]}`,
		"spaced prefix":     `{"version":1,"domains":[{"prefix":"a b-","domain":"a"}]}`,
		"upper domain":      `{"version":1,"domains":[{"prefix":"a-","domain":"AWS"}]}`,
		"duplicate prefix":  `{"version":1,"domains":[{"prefix":"a-","domain":"a"},{"prefix":"a-","domain":"b"}]}`,
		"malformed json":    `{"version":1,"domains":[`,
	}
	for name, data := range cases {
		if _, err := ParseDomainRegistry([]byte(data)); err == nil {
			t.Errorf("%s: expected error, got nil", name)
		}
	}
}

func TestDefaultRegistry_PreservesMappingsAndAddsNew(t *testing.T) {
	reg, err := DefaultDomainRegistry()
	if err != nil {
		t.Fatalf("default registry: %v", err)
	}
	cases := map[string]string{
		"eks-x": "eks", "terraform-x": "terraform", "tf-x": "terraform",
		"karpenter-x": "karpenter", "aurora-x": "aurora", "iam-x": "iam",
		"pi-x": "pi", "git-x": "git", "bd-x": "bd", "memory-x": "memory", "mq-x": "mq",
		"artifactory-x": "artifactory", "github-x": "github", "aws-x": "aws",
		"unclassified-x": "general", "eks": "general",
	}
	for key, want := range cases {
		if got := reg.Classify(key); got != want {
			t.Errorf("Classify(%q) = %q, want %q", key, got, want)
		}
	}
}

func TestDefaultRegistry_RepoFileMatchesEmbedded(t *testing.T) {
	data, err := os.ReadFile("domains.json")
	if err != nil {
		t.Fatalf("read repo domains.json: %v", err)
	}
	if string(data) != string(defaultDomainsJSON) {
		t.Errorf("embedded defaults differ from memory-server/domains.json")
	}
}

func TestClassify_LongestPrefixWins(t *testing.T) {
	reg := mustRegistry(t, `{"version":1,"domains":[
		{"prefix":"git-","domain":"git"},
		{"prefix":"git-hub-","domain":"github"}]}`)
	if got := reg.Classify("git-hub-actions"); got != "github" {
		t.Errorf("longest prefix: got %q, want github", got)
	}
	if got := reg.Classify("git-rebase"); got != "git" {
		t.Errorf("shorter prefix: got %q, want git", got)
	}
}

func TestResolveDomainRegistry(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, "missing.json")

	// Explicit missing file fails visibly.
	if _, _, err := ResolveDomainRegistry(missing, ""); err == nil {
		t.Errorf("explicit missing file must fail")
	}
	// Implicit missing installed file falls back to bundled defaults.
	reg, src, err := ResolveDomainRegistry("", missing)
	if err != nil {
		t.Fatalf("implicit fallback: %v", err)
	}
	if src != "bundled" || reg.Classify("aws-x") != "aws" {
		t.Errorf("implicit fallback src=%q aws=%q", src, reg.Classify("aws-x"))
	}
	// Custom registry fully replaces defaults.
	custom := filepath.Join(dir, "custom.json")
	os.WriteFile(custom, []byte(`{"version":1,"domains":[{"prefix":"zz-","domain":"zed"}]}`), 0o644)
	for _, args := range [][2]string{{custom, ""}, {"", custom}} {
		reg, src, err := ResolveDomainRegistry(args[0], args[1])
		if err != nil {
			t.Fatalf("custom: %v", err)
		}
		if src != custom || reg.Classify("zz-a") != "zed" || reg.Classify("eks-a") != "general" {
			t.Errorf("custom registry not applied as full replacement: src=%q", src)
		}
	}
	// Malformed installed registry fails (no silent fallback).
	bad := filepath.Join(dir, "bad.json")
	os.WriteFile(bad, []byte(`{"version":1}`), 0o644)
	if _, _, err := ResolveDomainRegistry("", bad); err == nil {
		t.Errorf("malformed installed registry must fail")
	}
}

type lessonSnapshot struct {
	text, domain, hash string
	vec                []byte
}

func snapshotDB(t *testing.T, path string) (map[string]lessonSnapshot, string) {
	t.Helper()
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	out := map[string]lessonSnapshot{}
	rows, err := db.Query(`SELECT l.key, l.text, l.domain, l.hash, v.embedding FROM lessons l JOIN lesson_vec v ON v.key = l.key`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var k string
		var s lessonSnapshot
		if err := rows.Scan(&k, &s.text, &s.domain, &s.hash, &s.vec); err != nil {
			t.Fatal(err)
		}
		out[k] = s
	}
	rows.Close()
	var b strings.Builder
	for _, q := range []string{
		"SELECT from_key||'>'||to_key||':'||score FROM similar_lessons ORDER BY 1",
		"SELECT child_id||'>'||lesson_key||':'||score FROM related_across ORDER BY 1",
		"SELECT id||'|'||text||'|'||hash FROM mission_children ORDER BY 1",
		"SELECT key||'='||value FROM meta ORDER BY 1",
		"SELECT key FROM child_vec ORDER BY 1",
	} {
		r, err := db.Query(q)
		if err != nil {
			t.Fatal(err)
		}
		for r.Next() {
			var s string
			r.Scan(&s)
			b.WriteString(s + "\n")
		}
		r.Close()
	}
	return out, b.String()
}

func seedBackfillDB(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "memory.db")
	store, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.InitSchema(); err != nil {
		t.Fatal(err)
	}
	emb := make([]float32, EmbedDims)
	emb[0], emb[1] = 0.6, 0.8
	lessons := []Lesson{
		{Key: "aws-sso-login", Text: "aws text", Domain: "general"},
		{Key: "github-actions-oidc", Text: "gh text", Domain: "general"},
		{Key: "artifactory-mirror", Text: "af text", Domain: "general"},
		{Key: "eks-taint", Text: "eks text", Domain: "eks"},
		{Key: "misc-thing", Text: "misc", Domain: "general"},
	}
	if err := store.InsertLessons(lessons, [][]float32{emb, emb, emb, emb, emb}); err != nil {
		t.Fatal(err)
	}
	store.InsertChildren([]Child{{ID: "m.1", MissionID: "m", Text: "child"}}, [][]float32{emb})
	store.InsertSimilarEdges([]Edge{{FromKey: "aws-sso-login", ToKey: "eks-taint", Score: 0.95}})
	store.InsertRelatedEdges([]Edge{{FromKey: "m.1", ToKey: "aws-sso-login", Score: 0.9}})
	store.SetSyncMetaStatus("complete")
	store.Checkpoint()
	return path
}

func TestBackfillDomains_MetadataOnlyAndIdempotent(t *testing.T) {
	path := seedBackfillDB(t)
	before, otherBefore := snapshotDB(t, path)
	reg, err := DefaultDomainRegistry()
	if err != nil {
		t.Fatal(err)
	}

	res, err := runBackfillDomains(path, reg)
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if res.Scanned != 5 || res.Changed != 3 {
		t.Errorf("scanned/changed = %d/%d, want 5/3", res.Scanned, res.Changed)
	}
	for _, d := range []string{"aws", "github", "artifactory"} {
		if res.ChangedByDomain[d] != 1 {
			t.Errorf("ChangedByDomain[%s] = %d, want 1", d, res.ChangedByDomain[d])
		}
	}

	after, otherAfter := snapshotDB(t, path)
	if otherBefore != otherAfter {
		t.Errorf("edges/children/meta changed:\n%s\nvs\n%s", otherBefore, otherAfter)
	}
	if len(after) != len(before) {
		t.Fatalf("lesson count changed %d -> %d", len(before), len(after))
	}
	wantDomain := map[string]string{"aws-sso-login": "aws", "github-actions-oidc": "github", "artifactory-mirror": "artifactory", "eks-taint": "eks", "misc-thing": "general"}
	for k, b := range before {
		a, ok := after[k]
		if !ok {
			t.Fatalf("lesson %s disappeared", k)
		}
		if a.text != b.text || a.hash != b.hash || string(a.vec) != string(b.vec) {
			t.Errorf("lesson %s text/hash/vector changed", k)
		}
		if a.domain != wantDomain[k] {
			t.Errorf("lesson %s domain = %q, want %q", k, a.domain, wantDomain[k])
		}
	}

	again, err := runBackfillDomains(path, reg)
	if err != nil {
		t.Fatalf("rerun: %v", err)
	}
	if again.Changed != 0 || again.Scanned != 5 {
		t.Errorf("rerun scanned/changed = %d/%d, want 5/0", again.Scanned, again.Changed)
	}
}

func TestBackfillDomains_RefusesMissingDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "absent.db")
	reg, _ := DefaultDomainRegistry()
	if _, err := runBackfillDomains(path, reg); err == nil {
		t.Fatalf("backfill must refuse a missing database")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("backfill created a database at %s", path)
	}
}

func TestBackfillDomains_RefusesNonIndexDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "empty.db")
	os.WriteFile(path, nil, 0o644)
	reg, _ := DefaultDomainRegistry()
	if _, err := runBackfillDomains(path, reg); err == nil {
		t.Fatalf("backfill must refuse a database without a lessons table")
	}
}

func TestBackfillDomains_EscapesDatabasePath(t *testing.T) {
	original := seedBackfillDB(t)
	path := filepath.Join(t.TempDir(), "memory?#.db")
	if err := os.Rename(original, path); err != nil {
		t.Fatal(err)
	}
	reg, err := DefaultDomainRegistry()
	if err != nil {
		t.Fatal(err)
	}
	res, err := runBackfillDomains(path, reg)
	if err != nil {
		t.Fatalf("backfill with URI characters in path: %v", err)
	}
	if res.Scanned != 5 || res.Changed != 3 {
		t.Fatalf("scanned/changed = %d/%d, want 5/3", res.Scanned, res.Changed)
	}
}

func TestBackfillDomains_RollsBackEveryUpdateOnFailure(t *testing.T) {
	path := seedBackfillDB(t)
	before, otherBefore := snapshotDB(t, path)
	store, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.db.Exec(`CREATE TRIGGER reject_github_domain BEFORE UPDATE OF domain ON lessons
		WHEN NEW.key = 'github-actions-oidc' AND NEW.domain <> OLD.domain
		BEGIN SELECT RAISE(ABORT, 'test domain rejection'); END`)
	if err != nil {
		store.Close()
		t.Fatal(err)
	}
	store.Close()
	reg, err := DefaultDomainRegistry()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := runBackfillDomains(path, reg); err == nil {
		t.Fatal("expected transaction failure")
	}
	after, otherAfter := snapshotDB(t, path)
	if otherBefore != otherAfter || len(before) != len(after) {
		t.Fatal("backfill failure changed indexed data")
	}
	for key, b := range before {
		a, ok := after[key]
		if !ok || a.text != b.text || a.domain != b.domain || a.hash != b.hash || string(a.vec) != string(b.vec) {
			t.Errorf("backfill failure changed lesson %s", key)
		}
	}
}

// Incremental sync must refresh lesson domains even when key/text hashes are
// unchanged, without embedding. All fixture hashes match, so the run takes the
// no-op branch; a bogus model dir proves no embedder work is needed.
func TestSyncIncremental_RefreshesDomainsWithoutReembed(t *testing.T) {
	withMxDB(t)
	reg := mustRegistry(t, `{"version":1,"domains":[{"prefix":"eks-","domain":"kube"}]}`)
	lessons, err := loadMemories(reg)
	if err != nil {
		t.Fatal(err)
	}
	children, partial, err := loadChildrenPartial()
	if err != nil || partial {
		t.Fatalf("children: %v partial=%v", err, partial)
	}
	path := filepath.Join(t.TempDir(), "memory.db")
	store, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	store.InitSchema()
	emb := make([]float32, EmbedDims)
	emb[0] = 1
	stale := make([]Lesson, len(lessons))
	lembs := make([][]float32, len(lessons))
	for i, l := range lessons {
		l.Domain = "stale"
		stale[i] = l
		lembs[i] = emb
	}
	cembs := make([][]float32, len(children))
	for i := range children {
		cembs[i] = emb
	}
	if err := store.InsertLessons(stale, lembs); err != nil {
		t.Fatal(err)
	}
	if err := store.InsertChildren(children, cembs); err != nil {
		t.Fatal(err)
	}
	store.Close()
	before, _ := snapshotDB(t, path)

	if err := runSyncIncremental(path, filepath.Join(t.TempDir(), "no-model"), reg); err != nil {
		t.Fatalf("incremental: %v", err)
	}
	after, _ := snapshotDB(t, path)
	for k, a := range after {
		want := reg.Classify(k)
		if a.domain != want {
			t.Errorf("%s domain = %q, want %q", k, a.domain, want)
		}
		if string(a.vec) != string(before[k].vec) || a.hash != before[k].hash {
			t.Errorf("%s vector/hash changed", k)
		}
	}
	if after["eks-sanitized-case-1"].domain != "kube" {
		t.Errorf("custom registry not applied by incremental sync")
	}
}

package main

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// withMxDB builds a throwaway mx.db from the real mx schema
// (../mx/src/schema.sql) and the rows in testdata/mx-fixture.json, then points
// MX_DB at it. No live store is ever touched.
func withMxDB(t *testing.T) string {
	t.Helper()
	schema, err := os.ReadFile(filepath.Join("..", "mx", "src", "schema.sql"))
	if err != nil {
		t.Fatalf("read mx schema: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join("testdata", "mx-fixture.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fx struct {
		Issues []struct {
			ID          string   `json:"id"`
			Title       string   `json:"title"`
			Description string   `json:"description"`
			Type        string   `json:"issue_type"`
			Status      string   `json:"status"`
			Parent      string   `json:"parent"`
			Labels      []string `json:"labels"`
		} `json:"issues"`
		Memories map[string]string `json:"memories"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	path := filepath.Join(t.TempDir(), "mx.db")
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mustExec := func(q string, args ...any) {
		t.Helper()
		if _, err := db.Exec(q, args...); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	mustExec(string(schema))
	mustExec(`insert into meta values ('schema_version', '1')`)
	const at = "2026-10-30T00:00:00Z"
	// Parents first: parent_id is a foreign key.
	for pass := 0; pass < 2; pass++ {
		for _, i := range fx.Issues {
			if (i.Parent == "") != (pass == 0) {
				continue
			}
			var parent any
			if i.Parent != "" {
				parent = i.Parent
			}
			mustExec(`insert into issues(id, title, description, status, issue_type, parent_id, created_at, updated_at)
				values (?, ?, ?, ?, ?, ?, ?, ?)`, i.ID, i.Title, i.Description, i.Status, i.Type, parent, at, at)
			for _, l := range i.Labels {
				mustExec(`insert into labels values (?, ?)`, i.ID, l)
			}
		}
	}
	for k, v := range fx.Memories {
		mustExec(`insert into memories values (?, ?, ?, ?)`, k, v, at, at)
	}
	t.Setenv("MX_DB", path)
	return path
}

func TestMxSource_RejectsMissingAndNewerSchema(t *testing.T) {
	t.Setenv("MX_DB", filepath.Join(t.TempDir(), "absent.db"))
	if _, err := loadEpics(); err == nil || !strings.Contains(err.Error(), "absent.db") {
		t.Errorf("missing store: err = %v, want the path in the error", err)
	}
	path := withMxDB(t)
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	db.Exec(`update meta set value='2' where key='schema_version'`)
	db.Close()
	if _, err := loadEpics(); err == nil || !strings.Contains(err.Error(), "schema_version 2") {
		t.Errorf("newer schema: err = %v, want a schema_version error", err)
	}
}

func TestMxRecallAndChildren(t *testing.T) {
	withMxDB(t)
	text, err := mxRecall("eks-sanitized-case-1")
	if err != nil || !strings.HasPrefix(text, "eks: reconcile by identity") {
		t.Errorf("recall = %q, %v", text, err)
	}
	if _, err := mxRecall("no-such-key"); err == nil {
		t.Errorf("recall of a missing key must fail")
	}
	kids, err := mxChildren("mission-l4w")
	if err != nil {
		t.Fatal(err)
	}
	if len(kids) != 3 || kids[0].ID != "mission-l4w.27" || kids[0].Type != "finding" {
		t.Errorf("children = %+v", kids)
	}
	if got := strings.Join(kids[0].Labels, ","); got != "finding,memory" {
		t.Errorf("labels = %q", got)
	}
}

// TestLoadMemories_CountAndDomain proves the loader + mx.db seam works and
// that lesson enumeration + domain classification are correct.
func TestLoadMemories_CountAndDomain(t *testing.T) {
	withMxDB(t)
	reg, err := DefaultDomainRegistry()
	if err != nil {
		t.Fatal(err)
	}
	lessons, err := loadMemories(reg)
	if err != nil {
		t.Fatalf("loadMemories: %v", err)
	}
	if len(lessons) != 56 {
		t.Errorf("loaded %d lessons, want 56 (>50 fixture, schema_version excluded)", len(lessons))
	}
	for _, l := range lessons {
		if l.Key == "eks-sanitized-case-1" && l.Domain != "eks" {
			t.Errorf("eks lesson domain = %q, want eks", l.Domain)
		}
		if l.Key == "schema_version" {
			t.Errorf("schema_version leaked into lessons")
		}
	}
}

// Coverage/freshness (mission-927.7): loadMissions enumerates every epic in
// mx.db, so closed epics are indexed and non-epic task rows are excluded.
func TestLoadMissions_EpicOnlyAllStatus(t *testing.T) {
	withMxDB(t)
	missions, err := loadMissions()
	if err != nil {
		t.Fatalf("loadMissions: %v", err)
	}
	byID := map[string]Mission{}
	for _, m := range missions {
		byID[m.ID] = m
	}
	if _, ok := byID["mission-l4w"]; !ok {
		t.Errorf("closed epic mission-l4w missing from enumeration")
	}
	if m, ok := byID["mission-l4w"]; !ok || m.Status != "closed" {
		t.Errorf("mission-l4w status = %q, want closed", byID["mission-l4w"].Status)
	}
	if _, ok := byID["mission-abc.1"]; ok {
		t.Errorf("non-epic task mission-abc.1 wrongly present as a mission")
	}
}

// Body-only evidence (mission-927.7): loadChildren preserves bounded body
// content + kind/status, not the title alone.
func TestLoadChildren_PreserveBody(t *testing.T) {
	withMxDB(t)
	children, err := loadChildren()
	if err != nil {
		t.Fatalf("loadChildren: %v", err)
	}
	var found bool
	for _, c := range children {
		if c.ID == "mission-l4w.27" {
			found = true
			if !strings.Contains(c.Text, "index missing 83 of 104 epics") {
				t.Errorf("child text lacks body evidence: %q", c.Text)
			}
			if c.Kind != "finding" || c.Status != "closed" {
				t.Errorf("child kind/status = %q/%q, want finding/closed", c.Kind, c.Status)
			}
			if c.Hash == "" {
				t.Errorf("child hash not set")
			}
		}
	}
	if !found {
		t.Errorf("mission-l4w.27 not enumerated")
	}
}

func TestLoadChildrenPartial_FullReadNotPartial(t *testing.T) {
	withMxDB(t)
	_, partial, err := loadChildrenPartial()
	if err != nil {
		t.Fatalf("loadChildrenPartial: %v", err)
	}
	if partial {
		t.Errorf("expected a complete read (mx.db serves every epic)")
	}
}

// mission-umwj.12: children come from ONE query grouped by parent, not
// per-epic lookups. Only rows whose parent is a known epic become children;
// parentless/orphan rows are excluded and MissionID is the parent epic.
func TestLoadChildrenPartial_GroupsByEpicParent(t *testing.T) {
	withMxDB(t)
	children, _, err := loadChildrenPartial()
	if err != nil {
		t.Fatalf("loadChildrenPartial: %v", err)
	}
	got := map[string]string{}
	for _, c := range children {
		got[c.ID] = c.MissionID
	}
	want := map[string]string{
		"mission-l4w.27": "mission-l4w",
		"mission-l4w.32": "mission-l4w",
		"mission-l4w.40": "mission-l4w",
	}
	if len(got) != len(want) {
		t.Fatalf("got %d children %v, want %d %v", len(got), got, len(want), want)
	}
	for id, parent := range want {
		if got[id] != parent {
			t.Errorf("child %s parent = %q, want %q", id, got[id], parent)
		}
	}
	if _, ok := got["mission-abc.1"]; ok {
		t.Errorf("orphan row mission-abc.1 (no epic parent) must be excluded")
	}
}

// Reconciliation (mission-927.7): reconcile diffs by identity + content hash and
// is idempotent. new -> Upsert, changed hash -> Upsert, missing -> Delete,
// equal hash -> Unchanged; re-running after apply yields no changes.
func TestReconcile_NewChangedDeletedIdempotent(t *testing.T) {
	source := map[string]string{"a": "h1", "b": "h2", "c": "h3"}
	indexed := map[string]string{"b": "h2", "c": "OLD", "d": "h4"}
	p := reconcile(source, indexed)
	if got := strings.Join(p.Upsert, ","); got != "a,c" {
		t.Errorf("Upsert = %q, want a,c (a new, c changed)", got)
	}
	if got := strings.Join(p.Delete, ","); got != "d" {
		t.Errorf("Delete = %q, want d", got)
	}
	if got := strings.Join(p.Unchanged, ","); got != "b" {
		t.Errorf("Unchanged = %q, want b", got)
	}
	// Idempotency: after applying the plan, index == source -> no changes.
	p2 := reconcile(source, source)
	if len(p2.Upsert) != 0 || len(p2.Delete) != 0 {
		t.Errorf("second reconcile not a no-op: %+v", p2)
	}
}

// Edge invalidation (mission-927.7): deleting a lesson removes its node, vector
// and every edge that touches it.
func TestStore_DeleteInvalidatesEdges(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer store.Close()
	if err := store.InitSchema(); err != nil {
		t.Fatalf("schema: %v", err)
	}
	emb := make([]float32, EmbedDims)
	emb[0] = 1
	if err := store.InsertLessons([]Lesson{{Key: "a", Text: "ta"}, {Key: "b", Text: "tb"}}, [][]float32{emb, emb}); err != nil {
		t.Fatalf("insert lessons: %v", err)
	}
	if err := store.InsertChildren([]Child{{ID: "m.1", MissionID: "m", Text: "child"}}, [][]float32{emb}); err != nil {
		t.Fatalf("insert child: %v", err)
	}
	store.InsertSimilarEdges([]Edge{{FromKey: "a", ToKey: "b", Score: 0.99}})
	store.InsertRelatedEdges([]Edge{{FromKey: "m.1", ToKey: "a", Score: 0.9}})

	if err := store.DeleteLessons([]string{"a"}); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if l, _ := store.GetLessonByKey("a"); l != nil {
		t.Errorf("lesson a still present after delete")
	}
	if edges, _ := store.GetSimilarLessons("b"); len(edges) != 0 {
		t.Errorf("SIMILAR_TO edge to deleted lesson a survived: %+v", edges)
	}
	if edges, _ := store.GetRelatedLessonsForChild("m.1"); len(edges) != 0 {
		t.Errorf("RELATED_ACROSS edge to deleted lesson a survived: %+v", edges)
	}
}

// Meta identity (mission-927.7): sync meta records model + schema identity and a
// complete/partial status so a stale/partial index or model mismatch is detectable.
func TestSyncMeta_ModelSchemaStatus(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer store.Close()
	if err := store.InitSchema(); err != nil {
		t.Fatalf("schema: %v", err)
	}
	if err := store.SetSyncMetaStatus("partial"); err != nil {
		t.Fatalf("set meta: %v", err)
	}
	if got := store.GetMeta("embed_model"); got != ModelName {
		t.Errorf("embed_model = %q, want %q", got, ModelName)
	}
	if got := store.GetMeta("schema_version"); got != SchemaVersion {
		t.Errorf("schema_version = %q, want %q", got, SchemaVersion)
	}
	if got := store.GetMeta("embed_dims"); got != "768" {
		t.Errorf("embed_dims = %q, want 768", got)
	}
	if got := store.GetMeta("sync_status"); got != "partial" {
		t.Errorf("sync_status = %q, want partial", got)
	}
}

// TestEmbedPassages_ChunkBoundary guards the OOM fix (memory-server-full-sync-oom):
// EmbedPassages must slice large inputs into bounded chunks instead of handing
// the whole corpus to fastembed at once (which spawns one unbounded concurrent
// ONNX session per 64-item batch and OOM-kills the process mid-sync). The fix
// must still return exactly one vector per input, in order, across chunk
// boundaries. Skips when the local model cache is absent.
func TestEmbedPassages_ChunkBoundary(t *testing.T) {
	home, _ := os.UserHomeDir()
	cache := filepath.Join(home, ".pi", "state", "models")
	if _, err := os.Stat(filepath.Join(cache, "fast-bge-base-en-v1.5")); err != nil {
		t.Skipf("model cache not present at %s: %v", cache, err)
	}

	// Span multiple chunks: chunk size is embedBatchSize*embedMaxConcurrent.
	n := embedBatchSize*embedMaxConcurrent*2 + 5
	texts := make([]string, n)
	for i := range texts {
		texts[i] = "memory server child record number " + strconv.Itoa(i)
	}

	emb := NewEmbedder(cache)
	defer emb.Close()

	got, err := emb.EmbedPassages(texts)
	if err != nil {
		t.Fatalf("EmbedPassages: %v", err)
	}
	if len(got) != n {
		t.Fatalf("got %d embeddings, want %d", len(got), n)
	}
	for i, v := range got {
		if len(v) != EmbedDims {
			t.Fatalf("embedding %d has dim %d, want %d", i, len(v), EmbedDims)
		}
	}

	// Order preservation across a chunk boundary: re-embed one text that lands
	// in the second chunk on its own; it must match the batched vector.
	idx := embedBatchSize * embedMaxConcurrent // first item of chunk 2
	single, err := emb.EmbedPassages([]string{texts[idx]})
	if err != nil {
		t.Fatalf("EmbedPassages single: %v", err)
	}
	for d := 0; d < EmbedDims; d++ {
		if diff := got[idx][d] - single[0][d]; diff > 1e-5 || diff < -1e-5 {
			t.Fatalf("chunk-boundary vector mismatch at dim %d: batched=%v single=%v", d, got[idx][d], single[0][d])
		}
	}
}

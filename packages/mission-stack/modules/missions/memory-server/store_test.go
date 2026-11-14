package main

import (
	"path/filepath"
	"testing"
)

// TestFTSRebuildAndMatch verifies the external-content FTS5 index is created by
// InitSchema, populated at insert time, and matches a bare identifier token
// that the vector floor would otherwise miss. Requires -tags sqlite_fts5.
func TestFTSRebuildAndMatch(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "fts.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()
	if err := store.InitSchema(); err != nil {
		t.Fatalf("init schema: %v", err)
	}

	emb := make([]float32, EmbedDims)
	lessons := []Lesson{
		{Key: "image-policy", Text: "trustedBaseImageSources must be set in the admission policy"},
		{Key: "aurora-drift", Text: "aurora iopt1 drift reconcile checklist"},
	}
	if err := store.InsertLessons(lessons, [][]float32{emb, emb}); err != nil {
		t.Fatalf("insert lessons: %v", err)
	}
	// Insert already rebuilds FTS; calling again must stay idempotent.
	if err := store.RebuildFTS(); err != nil {
		t.Fatalf("rebuild fts: %v", err)
	}

	var key string
	err = store.db.QueryRow(`
		SELECT t.key FROM lesson_fts f
		JOIN lessons t ON t.rowid = f.rowid
		WHERE lesson_fts MATCH ?
		ORDER BY bm25(lesson_fts)
		LIMIT 1`, `"trustedbaseimagesources"`).Scan(&key)
	if err != nil {
		t.Fatalf("fts match query: %v", err)
	}
	if key != "image-policy" {
		t.Fatalf("expected image-policy, got %q", key)
	}
}

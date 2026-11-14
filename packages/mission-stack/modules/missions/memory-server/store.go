package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math"
	"net/url"
	"path/filepath"
	"time"

	sqlite_vec "github.com/asg017/sqlite-vec-go-bindings/cgo"
	_ "github.com/mattn/go-sqlite3"
)

func init() {
	sqlite_vec.Auto()
}

// Store handles all sqlite-vec database operations.
type Store struct {
	db *sql.DB
}

// Lesson represents a stored lesson with metadata.
type Lesson struct {
	Key    string
	Text   string
	Domain string
	Hash   string // content hash for reconciliation (empty until computed)
}

// Child represents a mission child (finding/decision/action). Text is the
// composed embedding body (title + description evidence); Kind/Status/Title
// carry the source metadata so retrieval can show real references.
type Child struct {
	ID        string
	MissionID string
	Text      string
	Kind      string
	Status    string
	Title     string
	Hash      string
}

// contentHash returns a stable hash of a record's identity-relevant content,
// used to detect changed records during reconciliation.
func contentHash(parts ...string) string {
	h := sha256.New()
	for _, p := range parts {
		h.Write([]byte(p))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}

// Mission represents a mission with its children.
type Mission struct {
	ID       string
	Title    string
	Status   string
	Children []string // child IDs
}

// SearchHit is a scored result.
type SearchHit struct {
	Key    string
	Text   string
	Domain string
	Score  float64
}

// ChildHit is a scored child result.
type ChildHit struct {
	ID        string
	MissionID string
	Text      string
	Kind      string
	Status    string
	Score     float64
}

// DupMatch represents a duplicate check result.
type DupMatch struct {
	Key   string
	Text  string
	Score float64
}

// Edge represents a similarity relationship.
type Edge struct {
	FromKey string
	ToKey   string
	Score   float64
}

func OpenStore(path string) (*Store, error) {
	db, err := sql.Open("sqlite3", path+"?_journal_mode=WAL")
	if err != nil {
		return nil, err
	}
	// Enable WAL mode for better concurrent read performance
	db.Exec("PRAGMA journal_mode=WAL")
	db.Exec("PRAGMA synchronous=NORMAL")
	return &Store{db: db}, nil
}

// OpenExistingStore opens a database read-write without creating it.
func OpenExistingStore(path string) (*Store, error) {
	absolutePath, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	uri := url.URL{Scheme: "file", Path: absolutePath}
	uri.RawQuery = "mode=rw&_journal_mode=WAL"
	db, err := sql.Open("sqlite3", uri.String())
	if err != nil {
		return nil, err
	}
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) tableExists(name string) (bool, error) {
	var n int
	err := s.db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", name).Scan(&n)
	return n > 0, err
}

// RefreshLessonDomains reclassifies lessons.domain for every indexed lesson in
// one transaction. Only the domain column is written.
func (s *Store) RefreshLessonDomains(classify func(string) string) (BackfillResult, error) {
	res := BackfillResult{ChangedByDomain: map[string]int{}}
	tx, err := s.db.Begin()
	if err != nil {
		return res, err
	}
	defer tx.Rollback()

	rows, err := tx.Query("SELECT key, COALESCE(domain, '') FROM lessons ORDER BY key")
	if err != nil {
		return res, err
	}
	updates := map[string]string{}
	for rows.Next() {
		var key, domain string
		if err := rows.Scan(&key, &domain); err != nil {
			rows.Close()
			return res, err
		}
		res.Scanned++
		if want := classify(key); want != domain {
			updates[key] = want
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return res, err
	}
	for key, domain := range updates {
		if _, err := tx.Exec("UPDATE lessons SET domain = ? WHERE key = ?", domain, key); err != nil {
			return res, fmt.Errorf("update domain for %s: %w", key, err)
		}
		res.Changed++
		res.ChangedByDomain[domain]++
	}
	if err := tx.Commit(); err != nil {
		return BackfillResult{ChangedByDomain: map[string]int{}}, err
	}
	return res, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

// Checkpoint truncates the WAL into the main database file so the file can be
// swapped atomically (used by the candidate-DB rebuild).
func (s *Store) Checkpoint() error {
	_, err := s.db.Exec("PRAGMA wal_checkpoint(TRUNCATE)")
	return err
}

// InitSchema creates tables if they don't exist.
func (s *Store) InitSchema() error {
	schema := fmt.Sprintf(`
		CREATE TABLE IF NOT EXISTS lessons (
			key TEXT PRIMARY KEY,
			text TEXT NOT NULL,
			domain TEXT DEFAULT 'general',
			hash TEXT DEFAULT ''
		);
		CREATE TABLE IF NOT EXISTS missions (
			id TEXT PRIMARY KEY,
			title TEXT,
			status TEXT
		);
		CREATE TABLE IF NOT EXISTS mission_children (
			id TEXT PRIMARY KEY,
			mission_id TEXT NOT NULL,
			text TEXT NOT NULL,
			kind TEXT DEFAULT '',
			status TEXT DEFAULT '',
			title TEXT DEFAULT '',
			hash TEXT DEFAULT ''
		);
		CREATE TABLE IF NOT EXISTS similar_lessons (
			from_key TEXT,
			to_key TEXT,
			score REAL,
			PRIMARY KEY (from_key, to_key)
		);
		CREATE TABLE IF NOT EXISTS related_across (
			child_id TEXT,
			lesson_key TEXT,
			score REAL,
			PRIMARY KEY (child_id, lesson_key)
		);
		CREATE TABLE IF NOT EXISTS meta (
			key TEXT PRIMARY KEY,
			value TEXT
		);
		CREATE VIRTUAL TABLE IF NOT EXISTS lesson_vec USING vec0(
			key TEXT PRIMARY KEY,
			embedding float[%d] distance_metric=cosine
		);
		CREATE VIRTUAL TABLE IF NOT EXISTS child_vec USING vec0(
			key TEXT PRIMARY KEY,
			embedding float[%d] distance_metric=cosine
		);
		CREATE VIRTUAL TABLE IF NOT EXISTS lesson_fts USING fts5(
			key, text, content='lessons', content_rowid='rowid'
		);
		CREATE VIRTUAL TABLE IF NOT EXISTS child_fts USING fts5(
			title, text, content='mission_children', content_rowid='rowid'
		);
	`, EmbedDims, EmbedDims)
	if _, err := s.db.Exec(schema); err != nil {
		return err
	}
	return s.migrate()
}

// migrate adds columns introduced after the original schema to pre-existing
// databases. ADD COLUMN is idempotent-guarded by a table_info check so a live
// DB created before schema v2 is upgraded in place without a rebuild.
func (s *Store) migrate() error {
	adds := []struct{ table, col, def string }{
		{"lessons", "hash", "TEXT DEFAULT ''"},
		{"mission_children", "kind", "TEXT DEFAULT ''"},
		{"mission_children", "status", "TEXT DEFAULT ''"},
		{"mission_children", "title", "TEXT DEFAULT ''"},
		{"mission_children", "hash", "TEXT DEFAULT ''"},
	}
	for _, a := range adds {
		has, err := s.columnExists(a.table, a.col)
		if err != nil {
			return err
		}
		if !has {
			if _, err := s.db.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", a.table, a.col, a.def)); err != nil {
				return fmt.Errorf("migrate %s.%s: %w", a.table, a.col, err)
			}
		}
	}
	// External-content FTS tables created by InitSchema start empty and do not
	// track pre-existing base rows. Rebuild once so a live DB built before FTS
	// existed is upgraded in place (no re-embed). Idempotent + a no-op on an
	// empty DB; cheap over the current corpus (~1700 rows).
	return s.RebuildFTS()
}

// RebuildFTS repopulates the external-content FTS5 indexes from the lessons and
// mission_children base tables. External-content FTS does not track base-table
// writes automatically, so this runs after every index-time mutation
// (insert/delete/sync). NEVER call it from a read/search path.
func (s *Store) RebuildFTS() error {
	_, err := s.db.Exec(`
		INSERT INTO lesson_fts(lesson_fts) VALUES('rebuild');
		INSERT INTO child_fts(child_fts) VALUES('rebuild');`)
	return err
}

func (s *Store) columnExists(table, col string) (bool, error) {
	rows, err := s.db.Query(fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return false, err
		}
		if name == col {
			return true, nil
		}
	}
	return false, nil
}

// Search performs KNN search over lessons.
func (s *Store) SearchLessons(embedding []float32, k int) ([]SearchHit, error) {
	blob := float32ToBytes(embedding)
	rows, err := s.db.Query(`
		SELECT lv.key, lv.distance, l.text, l.domain
		FROM lesson_vec lv
		JOIN lessons l ON l.key = lv.key
		WHERE lv.embedding MATCH ?
		AND k = ?
		ORDER BY lv.distance
	`, blob, k)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var hits []SearchHit
	for rows.Next() {
		var key, text, domain string
		var distance float64
		if err := rows.Scan(&key, &distance, &text, &domain); err != nil {
			return nil, err
		}
		hits = append(hits, SearchHit{
			Key:    key,
			Text:   text,
			Domain: domain,
			Score:  cosineDistToScore(distance),
		})
	}
	return hits, nil
}

// SearchChildren performs KNN search over mission children.
func (s *Store) SearchChildren(embedding []float32, k int) ([]ChildHit, error) {
	blob := float32ToBytes(embedding)
	rows, err := s.db.Query(`
		SELECT cv.key, cv.distance, mc.mission_id, mc.text, mc.kind, mc.status
		FROM child_vec cv
		JOIN mission_children mc ON mc.id = cv.key
		WHERE cv.embedding MATCH ?
		AND k = ?
		ORDER BY cv.distance
	`, blob, k)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var hits []ChildHit
	for rows.Next() {
		var id, missionID, text, kind, status string
		var distance float64
		if err := rows.Scan(&id, &distance, &missionID, &text, &kind, &status); err != nil {
			return nil, err
		}
		hits = append(hits, ChildHit{
			ID:        id,
			MissionID: missionID,
			Text:      text,
			Kind:      kind,
			Status:    status,
			Score:     cosineDistToScore(distance),
		})
	}
	return hits, nil
}

// CheckDuplicate searches for near-duplicates of text, excluding proposedKey.
func (s *Store) CheckDuplicate(embedding []float32, excludeKey string, k int) ([]DupMatch, error) {
	blob := float32ToBytes(embedding)
	// Fetch more than k to account for exclusion
	rows, err := s.db.Query(`
		SELECT lv.key, lv.distance, l.text
		FROM lesson_vec lv
		JOIN lessons l ON l.key = lv.key
		WHERE lv.embedding MATCH ?
		AND k = ?
		ORDER BY lv.distance
	`, blob, k+5)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var matches []DupMatch
	for rows.Next() {
		var key, text string
		var distance float64
		if err := rows.Scan(&key, &distance, &text); err != nil {
			return nil, err
		}
		if key == excludeKey {
			continue
		}
		score := cosineDistToScore(distance)
		matches = append(matches, DupMatch{Key: key, Text: text, Score: score})
		if len(matches) >= k {
			break
		}
	}
	return matches, nil
}

// GetMission retrieves a mission by ID.
func (s *Store) GetMission(id string) (*Mission, error) {
	var m Mission
	err := s.db.QueryRow("SELECT id, title, status FROM missions WHERE id = ?", id).
		Scan(&m.ID, &m.Title, &m.Status)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.Query("SELECT id FROM mission_children WHERE mission_id = ?", id)
	if err != nil {
		return &m, nil
	}
	defer rows.Close()
	for rows.Next() {
		var cid string
		rows.Scan(&cid)
		m.Children = append(m.Children, cid)
	}
	return &m, nil
}

// GetChildrenForMission returns all children for a mission.
func (s *Store) GetChildrenForMission(missionID string) ([]Child, error) {
	rows, err := s.db.Query("SELECT id, mission_id, text FROM mission_children WHERE mission_id = ?", missionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var children []Child
	for rows.Next() {
		var c Child
		if err := rows.Scan(&c.ID, &c.MissionID, &c.Text); err != nil {
			return nil, err
		}
		children = append(children, c)
	}
	return children, nil
}

// GetSimilarLessons returns lesson-lesson edges for a given lesson key.
func (s *Store) GetSimilarLessons(key string) ([]Edge, error) {
	rows, err := s.db.Query(`
		SELECT to_key, score FROM similar_lessons WHERE from_key = ?
		UNION
		SELECT from_key, score FROM similar_lessons WHERE to_key = ?
		ORDER BY score DESC
	`, key, key)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var edges []Edge
	for rows.Next() {
		var e Edge
		e.FromKey = key
		rows.Scan(&e.ToKey, &e.Score)
		edges = append(edges, e)
	}
	return edges, nil
}

// GetRelatedLessonsForChild returns lesson-child cross edges.
func (s *Store) GetRelatedLessonsForChild(childID string) ([]Edge, error) {
	rows, err := s.db.Query(`
		SELECT lesson_key, score FROM related_across WHERE child_id = ?
		ORDER BY score DESC
	`, childID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var edges []Edge
	for rows.Next() {
		var e Edge
		e.FromKey = childID
		rows.Scan(&e.ToKey, &e.Score)
		edges = append(edges, e)
	}
	return edges, nil
}

// GetLessonByKey retrieves a single lesson.
func (s *Store) GetLessonByKey(key string) (*Lesson, error) {
	var l Lesson
	err := s.db.QueryRow("SELECT key, text, domain FROM lessons WHERE key = ?", key).
		Scan(&l.Key, &l.Text, &l.Domain)
	if err != nil {
		return nil, err
	}
	return &l, nil
}

// GetExistingLessonKeys returns all lesson keys currently in the DB.
func (s *Store) GetExistingLessonKeys() (map[string]bool, error) {
	rows, err := s.db.Query("SELECT key FROM lessons")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	keys := make(map[string]bool)
	for rows.Next() {
		var k string
		rows.Scan(&k)
		keys[k] = true
	}
	return keys, nil
}

// GetExistingChildIDs returns all child IDs currently in the DB.
func (s *Store) GetExistingChildIDs() (map[string]bool, error) {
	rows, err := s.db.Query("SELECT id FROM mission_children")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make(map[string]bool)
	for rows.Next() {
		var id string
		rows.Scan(&id)
		ids[id] = true
	}
	return ids, nil
}

// GetAllLessonEmbeddings returns all lesson embeddings for edge computation.
func (s *Store) GetAllLessonEmbeddings() ([]Lesson, [][]float32, error) {
	rows, err := s.db.Query(`
		SELECT l.key, l.text, l.domain, lv.embedding
		FROM lessons l
		JOIN lesson_vec lv ON lv.key = l.key
	`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	var lessons []Lesson
	var embeddings [][]float32
	for rows.Next() {
		var l Lesson
		var blob []byte
		if err := rows.Scan(&l.Key, &l.Text, &l.Domain, &blob); err != nil {
			return nil, nil, err
		}
		lessons = append(lessons, l)
		embeddings = append(embeddings, bytesToFloat32(blob))
	}
	return lessons, embeddings, nil
}

// GetSyncMeta returns sync metadata.
func (s *Store) GetSyncMeta() (syncTime string, syncSource string) {
	s.db.QueryRow("SELECT value FROM meta WHERE key = 'last_sync_ts'").Scan(&syncTime)
	s.db.QueryRow("SELECT value FROM meta WHERE key = 'last_sync_source'").Scan(&syncSource)
	return
}

// CountRows returns the row count of a table, or (0, err) if it is missing.
func (s *Store) CountRows(table string) (int, error) {
	var n int
	err := s.db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&n)
	return n, err
}

// GetMeta reads a single meta value (empty string if unset).
func (s *Store) GetMeta(key string) string {
	var v string
	s.db.QueryRow("SELECT value FROM meta WHERE key = ?", key).Scan(&v)
	return v
}

// SetMeta writes a single meta value.
func (s *Store) SetMeta(key, value string) error {
	_, err := s.db.Exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, value)
	return err
}

// SetSyncMeta stores sync timestamp + the model/schema identity and a
// complete/partial status so callers can detect a stale or partial index and
// a model/schema mismatch that requires a rebuild.
func (s *Store) SetSyncMeta() error {
	return s.SetSyncMetaStatus("complete")
}

func (s *Store) SetSyncMetaStatus(status string) error {
	ts := time.Now().UTC().Format(time.RFC3339)
	stmts := map[string]string{
		"last_sync_ts":     ts,
		"last_sync_source": "memory-server-go",
		"embed_model":      ModelName,
		"embed_dims":       fmt.Sprintf("%d", EmbedDims),
		"schema_version":   SchemaVersion,
		"sync_status":      status,
	}
	for k, v := range stmts {
		if err := s.SetMeta(k, v); err != nil {
			return err
		}
	}
	return nil
}

// GetLessonHashes returns key -> content hash for every indexed lesson.
func (s *Store) GetLessonHashes() (map[string]string, error) {
	rows, err := s.db.Query("SELECT key, hash FROM lessons")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	m := make(map[string]string)
	for rows.Next() {
		var k, h string
		if err := rows.Scan(&k, &h); err != nil {
			return nil, err
		}
		m[k] = h
	}
	return m, nil
}

// GetChildHashes returns id -> content hash for every indexed child.
func (s *Store) GetChildHashes() (map[string]string, error) {
	rows, err := s.db.Query("SELECT id, hash FROM mission_children")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	m := make(map[string]string)
	for rows.Next() {
		var id, h string
		if err := rows.Scan(&id, &h); err != nil {
			return nil, err
		}
		m[id] = h
	}
	return m, nil
}

// DeleteLessons removes lessons plus their vectors and every edge that touches
// them (SIMILAR_TO either side, RELATED_ACROSS lesson side). Used when a source
// lesson disappears so stale nodes and edges never linger in the index.
func (s *Store) DeleteLessons(keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, k := range keys {
		for _, q := range []string{
			"DELETE FROM lessons WHERE key = ?",
			"DELETE FROM lesson_vec WHERE key = ?",
			"DELETE FROM related_across WHERE lesson_key = ?",
		} {
			if _, err := tx.Exec(q, k); err != nil {
				return err
			}
		}
		if _, err := tx.Exec("DELETE FROM similar_lessons WHERE from_key = ? OR to_key = ?", k, k); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return s.RebuildFTS()
}

// DeleteChildren removes children plus their vectors and RELATED_ACROSS edges.
func (s *Store) DeleteChildren(ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, id := range ids {
		for _, q := range []string{
			"DELETE FROM mission_children WHERE id = ?",
			"DELETE FROM child_vec WHERE key = ?",
			"DELETE FROM related_across WHERE child_id = ?",
		} {
			if _, err := tx.Exec(q, id); err != nil {
				return err
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return s.RebuildFTS()
}

// DeleteSimilarEdgesFor removes SIMILAR_TO edges touching the given lesson keys
// so a re-embedded (changed) lesson gets fresh edges instead of stale ones.
func (s *Store) DeleteSimilarEdgesFor(keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, k := range keys {
		if _, err := tx.Exec("DELETE FROM similar_lessons WHERE from_key = ? OR to_key = ?", k, k); err != nil {
			return err
		}
		if _, err := tx.Exec("DELETE FROM related_across WHERE lesson_key = ?", k); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// --- Sync operations ---

// ClearAll drops and recreates data for a fresh sync.
func (s *Store) ClearAll() error {
	tables := []string{"lessons", "missions", "mission_children", "similar_lessons", "related_across", "lesson_vec", "child_vec"}
	for _, t := range tables {
		if _, err := s.db.Exec("DELETE FROM " + t); err != nil {
			return fmt.Errorf("clearing %s: %w", t, err)
		}
	}
	return nil
}

// InsertLessons bulk-inserts lessons with embeddings (upsert-safe).
func (s *Store) InsertLessons(lessons []Lesson, embeddings [][]float32) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmtL, _ := tx.Prepare("INSERT OR REPLACE INTO lessons (key, text, domain, hash) VALUES (?, ?, ?, ?)")
	stmtDelV, _ := tx.Prepare("DELETE FROM lesson_vec WHERE key = ?")
	stmtV, _ := tx.Prepare("INSERT INTO lesson_vec (key, embedding) VALUES (?, ?)")
	defer stmtL.Close()
	defer stmtDelV.Close()
	defer stmtV.Close()

	for i, l := range lessons {
		hash := l.Hash
		if hash == "" {
			hash = contentHash(l.Key, l.Text)
		}
		if _, err := stmtL.Exec(l.Key, l.Text, l.Domain, hash); err != nil {
			return err
		}
		stmtDelV.Exec(l.Key) // delete existing vec entry if any
		if _, err := stmtV.Exec(l.Key, float32ToBytes(embeddings[i])); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return s.RebuildFTS()
}

// InsertChildren bulk-inserts children with embeddings (upsert-safe).
func (s *Store) InsertChildren(children []Child, embeddings [][]float32) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmtC, _ := tx.Prepare("INSERT OR REPLACE INTO mission_children (id, mission_id, text, kind, status, title, hash) VALUES (?, ?, ?, ?, ?, ?, ?)")
	stmtDelV, _ := tx.Prepare("DELETE FROM child_vec WHERE key = ?")
	stmtV, _ := tx.Prepare("INSERT INTO child_vec (key, embedding) VALUES (?, ?)")
	defer stmtC.Close()
	defer stmtDelV.Close()
	defer stmtV.Close()

	for i, c := range children {
		hash := c.Hash
		if hash == "" {
			hash = contentHash(c.ID, c.Text)
		}
		if _, err := stmtC.Exec(c.ID, c.MissionID, c.Text, c.Kind, c.Status, c.Title, hash); err != nil {
			return err
		}
		stmtDelV.Exec(c.ID) // delete existing vec entry if any
		if _, err := stmtV.Exec(c.ID, float32ToBytes(embeddings[i])); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return s.RebuildFTS()
}

// InsertMissions bulk-inserts missions.
func (s *Store) InsertMissions(missions []Mission) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, _ := tx.Prepare("INSERT OR REPLACE INTO missions (id, title, status) VALUES (?, ?, ?)")
	defer stmt.Close()

	for _, m := range missions {
		if _, err := stmt.Exec(m.ID, m.Title, m.Status); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// InsertEdges bulk-inserts similarity edges.
func (s *Store) InsertSimilarEdges(edges []Edge) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, _ := tx.Prepare("INSERT OR REPLACE INTO similar_lessons (from_key, to_key, score) VALUES (?, ?, ?)")
	defer stmt.Close()
	for _, e := range edges {
		stmt.Exec(e.FromKey, e.ToKey, e.Score)
	}
	return tx.Commit()
}

// InsertRelatedEdges bulk-inserts cross edges.
func (s *Store) InsertRelatedEdges(edges []Edge) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, _ := tx.Prepare("INSERT OR REPLACE INTO related_across (child_id, lesson_key, score) VALUES (?, ?, ?)")
	defer stmt.Close()
	for _, e := range edges {
		stmt.Exec(e.FromKey, e.ToKey, e.Score)
	}
	return tx.Commit()
}

// --- Helpers ---

func float32ToBytes(v []float32) []byte {
	buf := make([]byte, len(v)*4)
	for i, f := range v {
		binary.LittleEndian.PutUint32(buf[i*4:], math.Float32bits(f))
	}
	return buf
}

func bytesToFloat32(b []byte) []float32 {
	v := make([]float32, len(b)/4)
	for i := range v {
		v[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[i*4:]))
	}
	return v
}

func cosineDistToScore(distance float64) float64 {
	// Raw cosine similarity: 1.0 = identical, 0.0 = orthogonal.
	// sqlite-vec cosine distance = 1 - cos_similarity, so invert.
	return 1.0 - distance
}

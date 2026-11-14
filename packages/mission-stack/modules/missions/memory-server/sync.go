package main

import (
	"fmt"
	"math"
	"os"
	"sort"
	"strings"
)

const (
	SimilarThreshold = 0.90 // lesson-lesson edges (raw cosine)
	RelatedThreshold = 0.84 // child-lesson cross edges (raw cosine)

	// childUpsertChunk is how many children the incremental sync embeds,
	// inserts and commits per iteration. Bounding the unit of work keeps a
	// large catch-up run durable: if it dies mid-sync, finished chunks persist
	// and the next run resumes from the remaining backlog.
	childUpsertChunk = 128
)

// removeDBFiles deletes a sqlite db path and its WAL/SHM sidecars.
func removeDBFiles(path string) {
	for _, p := range []string{path, path + "-wal", path + "-shm"} {
		os.Remove(p)
	}
}

// runSync performs a full rebuild into a temporary candidate database, then
// switches it over atomically. The live index is only replaced on success, so
// a failed or partial rebuild preserves the previous usable index
// (mission-927.7). A fresh full build inherently reconciles new/changed/deleted
// records because the candidate is rebuilt from the current source of truth.
func runSync(dbPath, cacheDir string, reg *DomainRegistry) error {
	candidate := dbPath + ".candidate"
	removeDBFiles(candidate)
	if err := buildFull(candidate, cacheDir, reg); err != nil {
		removeDBFiles(candidate)
		return err
	}
	// Atomic-ish switch: candidate WAL was checkpointed+truncated in buildFull,
	// so the main file is self-contained. Drop the old files and rename.
	removeDBFiles(dbPath)
	if err := os.Rename(candidate, dbPath); err != nil {
		return fmt.Errorf("swap candidate into place: %w", err)
	}
	removeDBFiles(candidate)
	fmt.Printf("    Swapped candidate -> %s\n", dbPath)
	return nil
}

// buildFull rebuilds a database file from scratch (used against a candidate
// path by runSync).
func buildFull(dbPath, cacheDir string, reg *DomainRegistry) error {
	store, err := OpenStore(dbPath)
	if err != nil {
		return fmt.Errorf("open db: %w", err)
	}
	defer store.Close()

	if err := store.InitSchema(); err != nil {
		return fmt.Errorf("init schema: %w", err)
	}

	// 1. Load data from the mx store
	fmt.Fprintf(os.Stderr, "Loading from mx.db...\n")
	memories, err := loadMemories(reg)
	if err != nil {
		return fmt.Errorf("load memories: %w", err)
	}

	children, err := loadChildren()
	if err != nil {
		return fmt.Errorf("load children: %w", err)
	}

	missions, err := loadMissions()
	if err != nil {
		return fmt.Errorf("load missions: %w", err)
	}

	fmt.Fprintf(os.Stderr, "  %d lessons, %d children, %d missions\n", len(memories), len(children), len(missions))

	// 2. Initialize embedder
	embedder := NewEmbedder(cacheDir)
	defer embedder.Close()

	// 3. Embed lessons
	fmt.Fprintf(os.Stderr, "Embedding %d lessons...\n", len(memories))
	lessonTexts := make([]string, len(memories))
	for i, l := range memories {
		lessonTexts[i] = l.Key + ": " + l.Text
	}
	lessonEmbs, err := embedder.EmbedPassages(lessonTexts)
	if err != nil {
		return fmt.Errorf("embed lessons: %w", err)
	}

	// 4. Embed children
	fmt.Fprintf(os.Stderr, "Embedding %d children...\n", len(children))
	childTexts := make([]string, len(children))
	for i, c := range children {
		childTexts[i] = c.Text
	}
	childEmbs, err := embedder.EmbedPassages(childTexts)
	if err != nil {
		return fmt.Errorf("embed children: %w", err)
	}

	// 5. Clear and rebuild
	fmt.Fprintf(os.Stderr, "Rebuilding database...\n")
	if err := store.ClearAll(); err != nil {
		return fmt.Errorf("clear: %w", err)
	}

	if err := store.InsertLessons(memories, lessonEmbs); err != nil {
		return fmt.Errorf("insert lessons: %w", err)
	}

	if err := store.InsertChildren(children, childEmbs); err != nil {
		return fmt.Errorf("insert children: %w", err)
	}

	if err := store.InsertMissions(missions); err != nil {
		return fmt.Errorf("insert missions: %w", err)
	}

	// 6. Compute similarity edges (lesson-lesson)
	fmt.Fprintf(os.Stderr, "Computing similarity edges...\n")
	similarEdges := computeSimilarEdges(lessonEmbs, memories)
	if err := store.InsertSimilarEdges(similarEdges); err != nil {
		return fmt.Errorf("insert similar edges: %w", err)
	}

	// 7. Compute cross edges (child-lesson)
	fmt.Fprintf(os.Stderr, "Computing cross edges...\n")
	crossEdges := computeCrossEdges(childEmbs, children, lessonEmbs, memories)
	if err := store.InsertRelatedEdges(crossEdges); err != nil {
		return fmt.Errorf("insert cross edges: %w", err)
	}

	// 8. Update meta + checkpoint so the file can be swapped atomically.
	store.SetSyncMeta()
	if err := store.Checkpoint(); err != nil {
		return fmt.Errorf("checkpoint candidate: %w", err)
	}

	fmt.Printf("✓ Sync complete:\n")
	fmt.Printf("    Lessons: %d\n", len(memories))
	fmt.Printf("    Children: %d\n", len(children))
	fmt.Printf("    Missions: %d\n", len(missions))
	fmt.Printf("    SIMILAR_TO edges: %d\n", len(similarEdges))
	fmt.Printf("    RELATED_ACROSS edges: %d\n", len(crossEdges))
	fmt.Printf("    DB path: %s\n", dbPath)

	return nil
}

// --- mx store loaders ---

// epicRow is the subset of issue fields the mission loader consumes.
type epicRow struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Status string `json:"status"`
	Type   string `json:"issue_type"`
}

// loadEpics enumerates every epic across ALL statuses (open + closed) with no
// row cap, so closed missions are indexed and non-epic task rows never
// masquerade as missions (mission-927.7).
func loadEpics() ([]epicRow, error) {
	db, err := openMx()
	if err != nil {
		return nil, err
	}
	defer db.Close()
	rows, err := db.Query(`select id, title, status, issue_type from issues where issue_type = 'epic' order by id`)
	if err != nil {
		return nil, fmt.Errorf("load epics: %w", err)
	}
	defer rows.Close()
	var epics []epicRow
	for rows.Next() {
		var r epicRow
		if err := rows.Scan(&r.ID, &r.Title, &r.Status, &r.Type); err != nil {
			return nil, err
		}
		epics = append(epics, r)
	}
	return epics, rows.Err()
}

// issueRow is the subset of issue fields the children loader consumes.
// The single full-issue enumeration carries `parent`, so children are grouped
// in memory instead of one lookup per epic (mission-umwj.12).
type issueRow struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Type        string   `json:"issue_type"`
	Status      string   `json:"status"`
	Parent      string   `json:"parent"`
	Labels      []string `json:"labels"`
}

// loadIssues enumerates every issue across ALL statuses in a single query
// (mission-927.7).
func loadIssues() ([]issueRow, error) {
	db, err := openMx()
	if err != nil {
		return nil, err
	}
	defer db.Close()
	rows, err := db.Query(`select i.id, i.title, i.description, i.issue_type, i.status,
		coalesce(i.parent_id, ''), ` + labelsExpr + ` from issues i order by i.id`)
	if err != nil {
		return nil, fmt.Errorf("load issues: %w", err)
	}
	defer rows.Close()
	var out []issueRow
	for rows.Next() {
		var r issueRow
		var labels string
		if err := rows.Scan(&r.ID, &r.Title, &r.Description, &r.Type, &r.Status, &r.Parent, &labels); err != nil {
			return nil, err
		}
		if r.Labels, err = scanLabels(labels); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// childRow is the subset of child issue fields the loader consumes.
type childRow struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Type        string   `json:"issue_type"`
	Status      string   `json:"status"`
	Labels      []string `json:"labels"`
}

// composeChildText builds the embedding body from a child row. The real
// evidence lives in the description, not the title, so both are indexed
// (bounded) with the kind prefix for context (mission-927.7).
func composeChildText(r childRow) string {
	title := strings.TrimSpace(r.Title)
	body := strings.TrimSpace(r.Description)
	var b strings.Builder
	if r.Type != "" {
		fmt.Fprintf(&b, "[%s] ", r.Type)
	}
	b.WriteString(title)
	if body != "" {
		b.WriteString("\n")
		if len(body) > 1200 {
			body = body[:1200]
		}
		b.WriteString(body)
	}
	return strings.TrimSpace(b.String())
}

func loadMemories(reg *DomainRegistry) ([]Lesson, error) {
	db, err := openMx()
	if err != nil {
		return nil, err
	}
	defer db.Close()
	rows, err := db.Query(`select key, text from memories order by key`)
	if err != nil {
		return nil, fmt.Errorf("load memories: %w", err)
	}
	defer rows.Close()
	var lessons []Lesson
	for rows.Next() {
		var k, text string
		if err := rows.Scan(&k, &text); err != nil {
			return nil, err
		}
		lessons = append(lessons, Lesson{Key: k, Text: text, Domain: reg.Classify(k), Hash: contentHash(k, text)})
	}
	return lessons, rows.Err()
}

// ReconcilePlan is the diff between the source of truth and the current index.
type ReconcilePlan struct {
	Upsert    []string // new or content-changed (must (re)embed)
	Delete    []string // present in index, absent from source
	Unchanged []string // hash matches; skip
}

// reconcile diffs source hashes against indexed hashes by identity + content
// hash. It is deterministic (sorted output) and idempotent: running it again
// after applying the plan yields empty Upsert/Delete. Callers must NOT apply
// Delete on a partial source read (see loadChildrenPartial).
func reconcile(sourceHashes, indexedHashes map[string]string) ReconcilePlan {
	var plan ReconcilePlan
	for id, h := range sourceHashes {
		old, ok := indexedHashes[id]
		if !ok || old != h {
			plan.Upsert = append(plan.Upsert, id)
		} else {
			plan.Unchanged = append(plan.Unchanged, id)
		}
	}
	for id := range indexedHashes {
		if _, ok := sourceHashes[id]; !ok {
			plan.Delete = append(plan.Delete, id)
		}
	}
	sort.Strings(plan.Upsert)
	sort.Strings(plan.Delete)
	sort.Strings(plan.Unchanged)
	return plan
}

// loadChildren enumerates children of every epic (all statuses) and preserves
// the body evidence + kind/status so the index reflects real content, not just
// titles. A per-epic children fetch failure is reported so callers can mark the
// sync partial rather than silently dropping a mission's children.
func loadChildren() ([]Child, error) {
	children, _, err := loadChildrenPartial()
	return children, err
}

// loadChildrenPartial enumerates every epic's children in a SINGLE query over
// mx.db and groups rows by parent in memory, rather than one lookup per epic
// (mission-umwj.12).
//
// The partial flag is retained for the caller contract (a partial read must NOT
// delete "missing" children) but a single query is all-or-nothing: on any
// query/parse failure it returns the error and the caller aborts before any
// delete, preserving the previous index. So a successful read is never partial.
func loadChildrenPartial() ([]Child, bool, error) {
	issues, err := loadIssues()
	if err != nil {
		return nil, false, err
	}
	epicIDs := make(map[string]bool)
	for _, r := range issues {
		if r.Type == "epic" {
			epicIDs[r.ID] = true
		}
	}
	var children []Child
	for _, r := range issues {
		if r.Parent == "" || !epicIDs[r.Parent] {
			continue
		}
		item := childRow{
			ID:          r.ID,
			Title:       r.Title,
			Description: r.Description,
			Type:        r.Type,
			Status:      r.Status,
			Labels:      r.Labels,
		}
		text := composeChildText(item)
		children = append(children, Child{
			ID:        r.ID,
			MissionID: r.Parent,
			Text:      text,
			Kind:      r.Type,
			Status:    r.Status,
			Title:     strings.TrimSpace(r.Title),
			Hash:      contentHash(r.ID, text, r.Status),
		})
	}
	return children, false, nil
}

func loadMissions() ([]Mission, error) {
	epics, err := loadEpics()
	if err != nil {
		return nil, err
	}
	var missions []Mission
	for _, e := range epics {
		missions = append(missions, Mission{
			ID:     e.ID,
			Title:  e.Title,
			Status: e.Status,
		})
	}
	return missions, nil
}

// --- Edge computation ---

func computeSimilarEdges(embeddings [][]float32, lessons []Lesson) []Edge {
	var edges []Edge
	n := len(embeddings)
	for i := 0; i < n; i++ {
		for j := i + 1; j < n; j++ {
			score := cosineSimilarityF32(embeddings[i], embeddings[j])
			if score >= SimilarThreshold {
				edges = append(edges, Edge{
					FromKey: lessons[i].Key,
					ToKey:   lessons[j].Key,
					Score:   score,
				})
			}
		}
	}
	return edges
}

func computeCrossEdges(childEmbs [][]float32, children []Child, lessonEmbs [][]float32, lessons []Lesson) []Edge {
	var edges []Edge
	for ci, cemb := range childEmbs {
		for li, lemb := range lessonEmbs {
			score := cosineSimilarityF32(cemb, lemb)
			if score >= RelatedThreshold {
				edges = append(edges, Edge{
					FromKey: children[ci].ID,
					ToKey:   lessons[li].Key,
					Score:   score,
				})
			}
		}
	}
	return edges
}

func cosineSimilarityF32(a, b []float32) float64 {
	var dot, normA, normB float64
	for i := range a {
		ai, bi := float64(a[i]), float64(b[i])
		dot += ai * bi
		normA += ai * ai
		normB += bi * bi
	}
	if normA == 0 || normB == 0 {
		return 0.0
	}
	return dot / (math.Sqrt(normA) * math.Sqrt(normB))
}

// runAddLesson indexes a single lesson by key. Reads text from mx.db, embeds,
// inserts, and computes SIMILAR_TO edges against all existing lessons. ~1-2s.
func runAddLesson(dbPath, cacheDir, key string, reg *DomainRegistry) error {
	store, err := OpenStore(dbPath)
	if err != nil {
		return fmt.Errorf("open db: %w", err)
	}
	defer store.Close()

	if err := store.InitSchema(); err != nil {
		return fmt.Errorf("init schema: %w", err)
	}

	// Check if already indexed
	if existing, _ := store.GetLessonByKey(key); existing != nil {
		fmt.Fprintf(os.Stderr, "Lesson %q already in index, re-embedding...\n", key)
	}

	raw, err := mxRecall(key)
	if err != nil {
		return err
	}
	text := strings.TrimSpace(raw)
	if text == "" {
		return fmt.Errorf("lesson %s has empty text", key)
	}

	lesson := Lesson{Key: key, Text: text, Domain: reg.Classify(key)}

	// Embed
	embedder := NewEmbedder(cacheDir)
	defer embedder.Close()

	embs, err := embedder.EmbedPassages([]string{key + ": " + text})
	if err != nil {
		return fmt.Errorf("embed: %w", err)
	}
	newEmb := embs[0]

	// Insert
	if err := store.InsertLessons([]Lesson{lesson}, [][]float32{newEmb}); err != nil {
		return fmt.Errorf("insert: %w", err)
	}

	// Compute SIMILAR_TO edges against all existing lessons
	allLessons, allEmbs, err := store.GetAllLessonEmbeddings()
	if err == nil {
		var edges []Edge
		for i, emb := range allEmbs {
			if allLessons[i].Key == key {
				continue
			}
			score := cosineSimilarityF32(newEmb, emb)
			if score >= SimilarThreshold {
				edges = append(edges, Edge{FromKey: key, ToKey: allLessons[i].Key, Score: score})
			}
		}
		if len(edges) > 0 {
			store.InsertSimilarEdges(edges)
		}
		fmt.Printf("\u2713 Indexed lesson %q (%d similar edges)\n", key, len(edges))
	} else {
		fmt.Printf("\u2713 Indexed lesson %q (edges skipped: %v)\n", key, err)
	}

	store.SetSyncMeta()
	return nil
}

// runAddChildren indexes new children for a single mission. Reads children
// from mx.db, diffs against DB, embeds new ones, computes cross edges. ~1-2s.
func runAddChildren(dbPath, cacheDir, missionID string) error {
	store, err := OpenStore(dbPath)
	if err != nil {
		return fmt.Errorf("open db: %w", err)
	}
	defer store.Close()

	if err := store.InitSchema(); err != nil {
		return fmt.Errorf("init schema: %w", err)
	}

	items, err := mxChildren(missionID)
	if err != nil {
		return fmt.Errorf("children of %s: %w", missionID, err)
	}

	// Diff against existing by content hash (new OR changed).
	indexedHashes, err := store.GetChildHashes()
	if err != nil {
		return fmt.Errorf("get existing children: %w", err)
	}

	var newChildren []Child
	for _, item := range items {
		text := composeChildText(item)
		hash := contentHash(item.ID, text, item.Status)
		if indexedHashes[item.ID] != hash {
			newChildren = append(newChildren, Child{
				ID:        item.ID,
				MissionID: missionID,
				Text:      text,
				Kind:      item.Type,
				Status:    item.Status,
				Title:     strings.TrimSpace(item.Title),
				Hash:      hash,
			})
		}
	}

	if len(newChildren) == 0 {
		fmt.Printf("\u2713 No new children for %s\n", missionID)
		return nil
	}

	// Embed new children
	embedder := NewEmbedder(cacheDir)
	defer embedder.Close()

	texts := make([]string, len(newChildren))
	for i, c := range newChildren {
		texts[i] = c.Text
	}
	newEmbs, err := embedder.EmbedPassages(texts)
	if err != nil {
		return fmt.Errorf("embed children: %w", err)
	}

	// Insert
	if err := store.InsertChildren(newChildren, newEmbs); err != nil {
		return fmt.Errorf("insert children: %w", err)
	}

	// Compute RELATED_ACROSS edges: new children vs all lessons
	allLessons, allLessonEmbs, err := store.GetAllLessonEmbeddings()
	if err == nil {
		var edges []Edge
		for ci, cemb := range newEmbs {
			for li, lemb := range allLessonEmbs {
				score := cosineSimilarityF32(cemb, lemb)
				if score >= RelatedThreshold {
					edges = append(edges, Edge{
						FromKey: newChildren[ci].ID,
						ToKey:   allLessons[li].Key,
						Score:   score,
					})
				}
			}
		}
		if len(edges) > 0 {
			store.InsertRelatedEdges(edges)
		}
		fmt.Printf("\u2713 Indexed %d new children for %s (%d cross edges)\n", len(newChildren), missionID, len(edges))
	} else {
		fmt.Printf("\u2713 Indexed %d new children for %s (edges skipped)\n", len(newChildren), missionID)
	}

	store.SetSyncMeta()
	return nil
}

// runSyncIncremental adds only NEW lessons/children that aren't yet in the DB.
// Much faster than full sync (~2-5s vs ~3min) — suitable for post-/land hook.
// runSyncIncremental reconciles the live index against the current source by
// identity + content hash: new and content-changed records are (re)embedded and
// upserted, records that disappeared from the source are deleted, and affected
// edges are invalidated and recomputed. It is idempotent (a second run with no
// source change is a no-op) and partial-safe (a partial children read never
// deletes children). Missions are always refreshed to catch status changes.
func runSyncIncremental(dbPath, cacheDir string, reg *DomainRegistry) error {
	store, err := OpenStore(dbPath)
	if err != nil {
		return fmt.Errorf("open db: %w", err)
	}
	defer store.Close()

	if err := store.InitSchema(); err != nil {
		return fmt.Errorf("init schema: %w", err)
	}

	// 1. Load current source of truth FIRST. Any hard failure here aborts
	// before a single delete, preserving the previous usable index.
	allMemories, err := loadMemories(reg)
	if err != nil {
		return fmt.Errorf("load memories: %w", err)
	}
	allChildren, childrenPartial, err := loadChildrenPartial()
	if err != nil {
		return fmt.Errorf("load children: %w", err)
	}
	allMissions, err := loadMissions()
	if err != nil {
		return fmt.Errorf("load missions: %w", err)
	}

	// 2. Build source hash maps + lookup tables.
	lessonByKey := make(map[string]Lesson, len(allMemories))
	lessonHashes := make(map[string]string, len(allMemories))
	for _, l := range allMemories {
		lessonByKey[l.Key] = l
		lessonHashes[l.Key] = l.Hash
	}
	childByID := make(map[string]Child, len(allChildren))
	childHashes := make(map[string]string, len(allChildren))
	for _, c := range allChildren {
		childByID[c.ID] = c
		childHashes[c.ID] = c.Hash
	}

	// 3. Reconcile against the index.
	indexedLessonHashes, err := store.GetLessonHashes()
	if err != nil {
		return fmt.Errorf("get indexed lesson hashes: %w", err)
	}
	indexedChildHashes, err := store.GetChildHashes()
	if err != nil {
		return fmt.Errorf("get indexed child hashes: %w", err)
	}
	lessonPlan := reconcile(lessonHashes, indexedLessonHashes)
	childPlan := reconcile(childHashes, indexedChildHashes)

	// A partial children read must not trigger deletions of unread children.
	if childrenPartial {
		fmt.Fprintf(os.Stderr, "  children read was partial: skipping child deletions this run\n")
		childPlan.Delete = nil
	}

	// 4. Apply deletions (removes stale nodes, vectors and edges).
	if err := store.DeleteLessons(lessonPlan.Delete); err != nil {
		return fmt.Errorf("delete lessons: %w", err)
	}
	if err := store.DeleteChildren(childPlan.Delete); err != nil {
		return fmt.Errorf("delete children: %w", err)
	}

	// Domain is metadata derived from the key: refresh it for every indexed
	// lesson (including hash-unchanged ones) without re-embedding.
	domainRes, err := store.RefreshLessonDomains(reg.Classify)
	if err != nil {
		return fmt.Errorf("refresh lesson domains: %w", err)
	}
	if domainRes.Changed > 0 {
		fmt.Fprintf(os.Stderr, "  lesson domains reclassified: %d\n", domainRes.Changed)
	}

	if len(lessonPlan.Upsert) == 0 && len(childPlan.Upsert) == 0 &&
		len(lessonPlan.Delete) == 0 && len(childPlan.Delete) == 0 {
		store.InsertMissions(allMissions)
		status := "complete"
		if childrenPartial {
			status = "partial"
		}
		store.SetSyncMetaStatus(status)
		fmt.Printf("✓ Incremental sync: index already current (0 changes)\n")
		return nil
	}

	fmt.Fprintf(os.Stderr, "Reconcile: lessons +/~%d -%d, children +/~%d -%d\n",
		len(lessonPlan.Upsert), len(lessonPlan.Delete), len(childPlan.Upsert), len(childPlan.Delete))

	embedder := NewEmbedder(cacheDir)
	defer embedder.Close()

	// 5. Upsert changed/new lessons. Invalidate their edges before recompute.
	if len(lessonPlan.Upsert) > 0 {
		upserts := make([]Lesson, 0, len(lessonPlan.Upsert))
		texts := make([]string, 0, len(lessonPlan.Upsert))
		for _, k := range lessonPlan.Upsert {
			l := lessonByKey[k]
			upserts = append(upserts, l)
			texts = append(texts, l.Key+": "+l.Text)
		}
		embs, err := embedder.EmbedPassages(texts)
		if err != nil {
			return fmt.Errorf("embed lessons: %w", err)
		}
		if err := store.DeleteSimilarEdgesFor(lessonPlan.Upsert); err != nil {
			return fmt.Errorf("invalidate lesson edges: %w", err)
		}
		if err := store.InsertLessons(upserts, embs); err != nil {
			return fmt.Errorf("insert lessons: %w", err)
		}
		// Recompute SIMILAR_TO for each upserted lesson vs the current corpus.
		allLessons, allEmbs, err := store.GetAllLessonEmbeddings()
		if err == nil {
			upsertSet := make(map[string]bool, len(lessonPlan.Upsert))
			for _, k := range lessonPlan.Upsert {
				upsertSet[k] = true
			}
			embByKey := make(map[string][]float32, len(allLessons))
			for i, l := range allLessons {
				embByKey[l.Key] = allEmbs[i]
			}
			var edges []Edge
			for _, k := range lessonPlan.Upsert {
				nemb := embByKey[k]
				for i, other := range allLessons {
					if other.Key == k {
						continue
					}
					// Avoid double-inserting an edge between two upserted lessons.
					if upsertSet[other.Key] && other.Key < k {
						continue
					}
					score := cosineSimilarityF32(nemb, allEmbs[i])
					if score >= SimilarThreshold {
						edges = append(edges, Edge{FromKey: k, ToKey: other.Key, Score: score})
					}
				}
			}
			if len(edges) > 0 {
				store.InsertSimilarEdges(edges)
			}
		}
	}

	// 6. Upsert changed/new children + recompute their cross edges. Processed
	// in chunks that each embed + InsertChildren + insert cross edges and commit
	// before the next chunk. If a long catch-up run is interrupted (OOM, Ctrl-C,
	// timeout), completed chunks persist, so the index converges across runs
	// instead of restarting the whole backlog each time.
	if len(childPlan.Upsert) > 0 {
		// Lesson embeddings are stable across the child loop: load once.
		allLessons, allLessonEmbs, lessonsErr := store.GetAllLessonEmbeddings()
		done := 0
		for start := 0; start < len(childPlan.Upsert); start += childUpsertChunk {
			end := start + childUpsertChunk
			if end > len(childPlan.Upsert) {
				end = len(childPlan.Upsert)
			}
			ids := childPlan.Upsert[start:end]
			upserts := make([]Child, 0, len(ids))
			texts := make([]string, 0, len(ids))
			for _, id := range ids {
				c := childByID[id]
				upserts = append(upserts, c)
				texts = append(texts, c.Text)
			}
			embs, err := embedder.EmbedPassages(texts)
			if err != nil {
				return fmt.Errorf("embed children: %w", err)
			}
			if err := store.InsertChildren(upserts, embs); err != nil {
				return fmt.Errorf("insert children: %w", err)
			}
			if lessonsErr == nil {
				var crossEdges []Edge
				for ci, cemb := range embs {
					for li, lemb := range allLessonEmbs {
						score := cosineSimilarityF32(cemb, lemb)
						if score >= RelatedThreshold {
							crossEdges = append(crossEdges, Edge{
								FromKey: upserts[ci].ID,
								ToKey:   allLessons[li].Key,
								Score:   score,
							})
						}
					}
				}
				if len(crossEdges) > 0 {
					store.InsertRelatedEdges(crossEdges)
				}
			}
			done += len(ids)
			fmt.Fprintf(os.Stderr, "  children embedded: %d/%d\n", done, len(childPlan.Upsert))
		}
	}

	// 7. Refresh missions + record sync status.
	store.InsertMissions(allMissions)
	status := "complete"
	if childrenPartial {
		status = "partial"
	}
	store.SetSyncMetaStatus(status)

	fmt.Printf("✓ Incremental reconcile complete (status=%s):\n", status)
	fmt.Printf("    Lessons upserted/deleted: %d/%d\n", len(lessonPlan.Upsert), len(lessonPlan.Delete))
	fmt.Printf("    Children upserted/deleted: %d/%d\n", len(childPlan.Upsert), len(childPlan.Delete))
	fmt.Printf("    DB path: %s\n", dbPath)
	return nil
}

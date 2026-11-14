package main

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

const (
	ScoreFloor  = 0.70
	TailGap     = 0.05
	DupMerge    = 0.96
	DupLikely   = 0.93
	DupRelated  = 0.90
	MaxLessons  = 8
	MaxChildren = 8
)

// runSearch performs semantic search. With jsonOut it emits a versioned JSON
// envelope; otherwise it prints human Markdown. domain/kind filters are applied
// natively over a widened candidate pool so a valid match is never lost to
// pre-filter top-k truncation.
func runSearch(dbPath, cacheDir, query string, jsonOut bool, domain, kind string) error {
	store, err := OpenStore(dbPath)
	if err != nil {
		if jsonOut {
			emitJSONError("search", query, "open_db", err)
		}
		return fmt.Errorf("open db: %w", err)
	}
	defer store.Close()

	embedder := NewEmbedder(cacheDir)
	defer embedder.Close()

	emb, err := embedder.EmbedQuery(query)
	if err != nil {
		if jsonOut {
			emitJSONError("search", query, "embed", err)
		}
		return fmt.Errorf("embed: %w", err)
	}

	// Widen the candidate pool when a filter is set so filtering happens over a
	// large slice, not the pre-truncated top-k.
	poolLessons, poolChildren := MaxLessons, MaxChildren
	if domain != "" {
		poolLessons = 500
	}
	if kind != "" {
		poolChildren = 500
	}

	lessons, err := store.SearchLessons(emb, poolLessons)
	if err != nil {
		if jsonOut {
			emitJSONError("search", query, "search_lessons", err)
		}
		return fmt.Errorf("search lessons: %w", err)
	}
	children, err := store.SearchChildren(emb, poolChildren)
	if err != nil {
		if jsonOut {
			emitJSONError("search", query, "search_children", err)
		}
		return fmt.Errorf("search children: %w", err)
	}

	// Native filters (before floor/tail-gap so relevance shaping is per-domain).
	if domain != "" {
		var kept []SearchHit
		for _, h := range lessons {
			if h.Domain == domain {
				kept = append(kept, h)
			}
		}
		lessons = kept
	}
	if kind != "" {
		var kept []ChildHit
		for _, h := range children {
			if h.Kind == kind {
				kept = append(kept, h)
			}
		}
		children = kept
	}

	// Apply score floor and tail gap to get the admitted vector hits, then fuse
	// with the FTS5 keyword ranking via RRF. Bare-identifier queries that never
	// clear the cosine floor are recovered from the keyword side; each hit keeps
	// its real cosine Score, RRF only reorders (mission-umwj.1/.3).
	lessons = filterHits(lessons)
	children = filterChildHits(children)
	lessons, lTier := store.fuseLessons(emb, query, domain, lessons)
	children, cTier := store.fuseChildren(emb, query, kind, children)

	if len(lessons) > MaxLessons {
		lessons = lessons[:MaxLessons]
	}
	if len(children) > MaxChildren {
		children = children[:MaxChildren]
	}

	if jsonOut {
		env := newEnvelope("search", query)
		env.SyncStatus = store.GetMeta("sync_status")
		if domain != "" || kind != "" {
			env.Filters = &Filters{Domain: domain, Kind: kind}
		}
		for _, h := range lessons {
			env.Hits = append(env.Hits, JSONHit{
				Type: "lesson", Key: h.Key, Domain: h.Domain, Score: h.Score,
				Excerpt: truncate(h.Text, 200), Provenance: "bd:lesson",
				Tier: lTier[h.Key],
			})
		}
		for _, h := range children {
			env.Hits = append(env.Hits, JSONHit{
				Type: "mission_child", Key: h.ID, MissionID: h.MissionID, Kind: h.Kind,
				Status: h.Status, Score: h.Score, Excerpt: truncate(h.Text, 200),
				Provenance: "bd:child", Tier: cTier[h.ID],
			})
		}
		return emitJSON(env)
	}

	if len(lessons) == 0 && len(children) == 0 {
		fmt.Println("No relevant prior art found.")
		return nil
	}

	if len(lessons) > 0 {
		fmt.Println("## 📚 Related Lessons")
		fmt.Println()
		for _, h := range lessons {
			truncText := truncate(h.Text, 200)
			fmt.Printf("- **[%.2f]** `%s` (%s)\n  %s\n\n", h.Score, h.Key, h.Domain, truncText)
		}
	}

	if len(children) > 0 {
		fmt.Println("## 📋 Related Mission Work")
		fmt.Println()
		for _, h := range children {
			truncText := truncate(h.Text, 200)
			fmt.Printf("- **[%.2f]** [%s] %s\n  %s\n\n", h.Score, h.MissionID, h.ID, truncText)
		}
	}

	return nil
}

type duplicateResolution struct {
	relevant []DupMatch
	verdict  string
	topScore float64
	exactKey *Lesson
}

// resolveDuplicateCheck keeps the proposed key out of similarity ranking, but
// reports an already stored key explicitly. Semantic matches still drive the
// duplicate verdict when the proposed key is absent.
func resolveDuplicateCheck(proposedKey string, matches []DupMatch, exact *Lesson) duplicateResolution {
	var ranked []DupMatch
	for _, m := range matches {
		if m.Key != proposedKey {
			ranked = append(ranked, m)
		}
	}
	var relevant []DupMatch
	var prevScore float64
	for i, m := range ranked {
		if m.Score < DupRelated {
			break
		}
		if i > 0 && prevScore-m.Score > TailGap {
			break
		}
		relevant = append(relevant, m)
		prevScore = m.Score
	}

	if exact != nil {
		return duplicateResolution{
			relevant: relevant,
			verdict:  "existing_key",
			topScore: 1,
			exactKey: exact,
		}
	}
	topScore := 0.0
	if len(relevant) > 0 {
		topScore = relevant[0].Score
	}
	return duplicateResolution{
		relevant: relevant,
		verdict:  classifyDupVerdict(topScore),
		topScore: topScore,
	}
}

func exactKeyHit(lesson *Lesson) JSONHit {
	return JSONHit{
		Type: "lesson", Key: lesson.Key, Score: 1,
		Excerpt: truncate(lesson.Text, 200), Provenance: "bd:lesson",
		Tier: "existing_key",
	}
}

// dupTierLabel maps a score to the human tier label.
func dupTierLabel(score float64) string {
	switch {
	case score >= DupMerge:
		return "🔴 MERGE CANDIDATE"
	case score >= DupLikely:
		return "🔴 LIKELY DUPLICATE"
	default:
		return "🟡 RELATED"
	}
}

// runCheckDup checks for near-duplicate lessons. Preview (Markdown) and the
// write gate (JSON) run the SAME passage comparison, self-key exclusion and
// tier config, so their verdicts never disagree. No merge is automatic.
func runCheckDup(dbPath, cacheDir, text, proposedKey string, jsonOut bool) error {
	store, err := OpenStore(dbPath)
	if err != nil {
		if jsonOut {
			emitJSONError("check-dup", "", "open_db", err)
		}
		return fmt.Errorf("open db: %w", err)
	}
	defer store.Close()

	embedder := NewEmbedder(cacheDir)
	defer embedder.Close()

	// Embed as passage (it's lesson text, not a query). This is the same
	// passage comparison both surfaces use.
	embedText := text
	if proposedKey != "" {
		embedText = proposedKey + ": " + text
	}
	embs, err := embedder.EmbedPassages([]string{embedText})
	if err != nil {
		if jsonOut {
			emitJSONError("check-dup", "", "embed", err)
		}
		return fmt.Errorf("embed: %w", err)
	}

	matches, err := store.CheckDuplicate(embs[0], "", 5)
	if err != nil {
		if jsonOut {
			emitJSONError("check-dup", "", "check_dup", err)
		}
		return fmt.Errorf("check dup: %w", err)
	}
	var exact *Lesson
	if proposedKey != "" {
		exact, err = store.GetLessonByKey(proposedKey)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			if jsonOut {
				emitJSONError("check-dup", "", "exact_key", err)
			}
			return fmt.Errorf("exact key: %w", err)
		}
		if errors.Is(err, sql.ErrNoRows) {
			exact = nil
		}
	}
	resolved := resolveDuplicateCheck(proposedKey, matches, exact)

	if jsonOut {
		env := newEnvelope("check-dup", "")
		env.SyncStatus = store.GetMeta("sync_status")
		dup := &DupResult{
			ProposedKey: proposedKey,
			Verdict:     resolved.verdict,
			TopScore:    resolved.topScore,
			Tiers:       canonicalTiers(),
		}
		if resolved.exactKey != nil {
			hit := exactKeyHit(resolved.exactKey)
			dup.ExactKey = &hit
		}
		for _, m := range resolved.relevant {
			dup.Matches = append(dup.Matches, JSONHit{
				Type: "lesson", Key: m.Key, Score: m.Score,
				Excerpt: truncate(m.Text, 200), Provenance: "bd:lesson",
				Tier: classifyDupVerdict(m.Score),
			})
		}
		env.Duplicate = dup
		return emitJSON(env)
	}

	if resolved.exactKey != nil {
		fmt.Printf("⚠️ **Existing key:** `%s`\n\nUpdate it in place instead of treating this check as a new lesson.\n```bash\nbd remember \"<merged insight>\" --key %s\n```\n", resolved.exactKey.Key, resolved.exactKey.Key)
		if len(resolved.relevant) > 0 {
			fmt.Println("\nOther similar lessons:")
		}
	}
	if len(resolved.relevant) == 0 && resolved.exactKey == nil {
		fmt.Println("✅ No similar lessons found. Safe to `mx remember`.")
		return nil
	}

	if resolved.exactKey == nil {
		fmt.Println("⚠️ **Similar lessons already exist:**")
		fmt.Println()
	}
	for _, m := range resolved.relevant {
		truncText := truncate(m.Text, 200)
		fmt.Printf("- %s [%.3f] `%s`\n  %s\n\n", dupTierLabel(m.Score), m.Score, m.Key, truncText)
	}
	if resolved.exactKey == nil && (resolved.verdict == "merge" || resolved.verdict == "likely") {
		fmt.Printf("\n**Recommendation:** Update `%s` instead of creating a new key.\n", resolved.relevant[0].Key)
		fmt.Printf("```bash\nbd remember \"<merged insight>\" --key %s\n```\n", resolved.relevant[0].Key)
	}

	return nil
}

// runRelated finds missions related to a query.
func runRelated(dbPath, cacheDir, query string, jsonOut bool) error {
	store, err := OpenStore(dbPath)
	if err != nil {
		if jsonOut {
			emitJSONError("related", query, "open_db", err)
		}
		return fmt.Errorf("open db: %w", err)
	}
	defer store.Close()

	embedder := NewEmbedder(cacheDir)
	defer embedder.Close()

	emb, err := embedder.EmbedQuery(query)
	if err != nil {
		if jsonOut {
			emitJSONError("related", query, "embed", err)
		}
		return fmt.Errorf("embed: %w", err)
	}

	children, err := store.SearchChildren(emb, 20)
	if err != nil {
		if jsonOut {
			emitJSONError("related", query, "search", err)
		}
		return fmt.Errorf("search: %w", err)
	}

	// Group by mission, take top score per mission
	groups := map[string]*sortableMissionGroup{}
	for _, c := range children {
		if c.Score < ScoreFloor {
			continue
		}
		g, ok := groups[c.MissionID]
		if !ok {
			g = &sortableMissionGroup{ID: c.MissionID}
			groups[c.MissionID] = g
		}
		if c.Score > g.TopScore {
			g.TopScore = c.Score
		}
		if len(g.Children) < 3 {
			g.Children = append(g.Children, c)
		}
	}

	// Sort by top score
	sorted := sortMissionGroups(groups)

	if jsonOut {
		env := newEnvelope("related", query)
		env.SyncStatus = store.GetMeta("sync_status")
		for _, g := range sorted {
			m, _ := store.GetMission(g.ID)
			jm := JSONMission{ID: g.ID, Title: g.ID, TopScore: g.TopScore}
			if m != nil {
				jm.Title = m.Title
				jm.Status = m.Status
			}
			for _, c := range g.Children {
				jm.Children = append(jm.Children, JSONHit{
					Type: "mission_child", Key: c.ID, MissionID: c.MissionID, Kind: c.Kind,
					Status: c.Status, Score: c.Score, Excerpt: truncate(c.Text, 120),
					Provenance: "bd:child",
				})
			}
			env.Missions = append(env.Missions, jm)
		}
		return emitJSON(env)
	}

	if len(groups) == 0 {
		fmt.Printf("_No graph footprint for this query._\n")
		return nil
	}

	fmt.Println("## 🗺️ Related Missions")
	fmt.Println()
	for _, g := range sorted {
		m, _ := store.GetMission(g.ID)
		title := g.ID
		status := ""
		if m != nil {
			title = m.Title
			status = m.Status
		}
		fmt.Printf("### [%s] %s", g.ID, title)
		if status != "" {
			fmt.Printf(" _%s_", status)
		}
		fmt.Println()
		for _, c := range g.Children {
			truncText := truncate(c.Text, 120)
			fmt.Printf("  - [%.2f] %s: %s\n", c.Score, c.ID, truncText)
		}
		fmt.Println()
	}

	return nil
}

// runBlastRadius shows the graph neighborhood of a mission.
func runBlastRadius(dbPath, cacheDir, missionID string, jsonOut bool) error {
	store, err := OpenStore(dbPath)
	if err != nil {
		if jsonOut {
			emitJSONError("blast-radius", missionID, "open_db", err)
		}
		return fmt.Errorf("open db: %w", err)
	}
	defer store.Close()

	syncTime, _ := store.GetSyncMeta()

	children, err := store.GetChildrenForMission(missionID)
	if err != nil || len(children) == 0 {
		if jsonOut {
			env := newEnvelope("blast-radius", missionID)
			env.SyncStatus = store.GetMeta("sync_status")
			return emitJSON(env)
		}
		fmt.Printf("_`%s` has no graph footprint — either the mission doesn't exist or has no children._\n", missionID)
		return nil
	}

	fmt.Printf("## 🕶️ Blast radius for `%s`\n", missionID)
	if syncTime != "" {
		fmt.Printf("_graph last synced %s via memory-server-go — stale missions/lessons won't show up here_\n\n", syncTime[:16])
	}

	lessonMap := map[string]*lessonReachSorted{}

	for _, child := range children {
		edges, err := store.GetRelatedLessonsForChild(child.ID)
		if err != nil {
			continue
		}
		for _, e := range edges {
			lr, ok := lessonMap[e.ToKey]
			if !ok {
				lesson, err := store.GetLessonByKey(e.ToKey)
				if err != nil {
					continue
				}
				lr = &lessonReachSorted{Key: lesson.Key, Text: lesson.Text, Domain: lesson.Domain, Score: e.Score}
				lessonMap[e.ToKey] = lr
			}
			if e.Score > lr.Score {
				lr.Score = e.Score
			}
			lr.ViaChildren = append(lr.ViaChildren, child.ID)
		}
	}

	if len(lessonMap) == 0 {
		if jsonOut {
			env := newEnvelope("blast-radius", missionID)
			env.SyncStatus = store.GetMeta("sync_status")
			return emitJSON(env)
		}
		fmt.Printf("_`%s` has children but no cross-mission neighbors above the score floor._\n", missionID)
		return nil
	}

	// Sort and print
	sorted := sortLessonReachMap(lessonMap)

	if jsonOut {
		env := newEnvelope("blast-radius", missionID)
		env.SyncStatus = store.GetMeta("sync_status")
		for _, lr := range sorted {
			env.Hits = append(env.Hits, JSONHit{
				Type: "lesson", Key: lr.Key, Domain: lr.Domain, Score: lr.Score,
				Excerpt: truncate(lr.Text, 200), Provenance: "bd:lesson",
			})
		}
		return emitJSON(env)
	}

	fmt.Println("### Lessons reached via mission children")
	for _, lr := range sorted {
		if len(lr.ViaChildren) > 3 {
			lr.ViaChildren = lr.ViaChildren[:3]
		}
		truncText := truncate(lr.Text, 200)
		fmt.Printf("- **[%.2f]** `%s` (%s)\n", lr.Score, lr.Key, lr.Domain)
		fmt.Printf("  _via_: `%s`\n", strings.Join(lr.ViaChildren, "`, `"))
		fmt.Printf("  %s\n\n", truncText)
	}

	return nil
}

// runStatus emits a read-only coverage + identity snapshot. It never embeds and
// never writes (no InitSchema): missing tables just mean the index is not built.
func runStatus(dbPath string, jsonOut bool) error {
	store, err := OpenStore(dbPath)
	if err != nil {
		if jsonOut {
			emitJSONError("status", "", "open_db", err)
		}
		return fmt.Errorf("open db: %w", err)
	}
	defer store.Close()

	lessons, lerr := store.CountRows("lessons")
	children, _ := store.CountRows("mission_children")
	missions, _ := store.CountRows("missions")
	similar, _ := store.CountRows("similar_lessons")
	related, _ := store.CountRows("related_across")
	indexed := lerr == nil

	info := &StatusInfo{
		Indexed:      indexed,
		Lessons:      lessons,
		Children:     children,
		Missions:     missions,
		SimilarEdges: similar,
		RelatedEdges: related,
		LastSyncTs:   store.GetMeta("last_sync_ts"),
		SyncStatus:   store.GetMeta("sync_status"),
		EmbedModel:   store.GetMeta("embed_model"),
		EmbedDims:    store.GetMeta("embed_dims"),
		IndexSchema:  store.GetMeta("schema_version"),
	}

	if jsonOut {
		env := newEnvelope("status", "")
		env.SyncStatus = info.SyncStatus
		env.Status = info
		return emitJSON(env)
	}

	fmt.Printf("## 🧠 memory-server status\n\n")
	if !indexed {
		fmt.Printf("- index: NOT BUILT (run a full sync)\n")
		return nil
	}
	fmt.Printf("- lessons: %d, children: %d, missions: %d\n", lessons, children, missions)
	fmt.Printf("- edges: %d SIMILAR_TO, %d RELATED_ACROSS\n", similar, related)
	fmt.Printf("- model: %s (%s dims), index schema v%s, binary schema v%s\n", info.EmbedModel, info.EmbedDims, info.IndexSchema, SchemaVersion)
	fmt.Printf("- last sync: %s (%s)\n", info.LastSyncTs, info.SyncStatus)
	return nil
}

// --- Helpers ---

func filterHits(hits []SearchHit) []SearchHit {
	var filtered []SearchHit
	var prevScore float64
	for i, h := range hits {
		if h.Score < ScoreFloor {
			break
		}
		if i > 0 && prevScore-h.Score > TailGap {
			break
		}
		filtered = append(filtered, h)
		prevScore = h.Score
	}
	return filtered
}

func filterChildHits(hits []ChildHit) []ChildHit {
	var filtered []ChildHit
	var prevScore float64
	for i, h := range hits {
		if h.Score < ScoreFloor {
			break
		}
		if i > 0 && prevScore-h.Score > TailGap {
			break
		}
		filtered = append(filtered, h)
		prevScore = h.Score
	}
	return filtered
}

func truncate(s string, maxLen int) string {
	// Take first line or maxLen chars, whichever is shorter
	if idx := strings.Index(s, "\n"); idx > 0 && idx < maxLen {
		s = s[:idx]
	}
	if len(s) > maxLen {
		return s[:maxLen] + "..."
	}
	return s
}

type sortableMissionGroup struct {
	ID       string
	TopScore float64
	Children []ChildHit
}

func sortMissionGroups(groups map[string]*sortableMissionGroup) []sortableMissionGroup {
	result := make([]sortableMissionGroup, 0, len(groups))
	for _, g := range groups {
		result = append(result, *g)
	}
	// Simple insertion sort (small N)
	for i := 1; i < len(result); i++ {
		for j := i; j > 0 && result[j].TopScore > result[j-1].TopScore; j-- {
			result[j], result[j-1] = result[j-1], result[j]
		}
	}
	return result
}

type lessonReachSorted struct {
	Key         string
	Text        string
	Domain      string
	Score       float64
	ViaChildren []string
}

func sortLessonReachMap(m map[string]*lessonReachSorted) []lessonReachSorted {
	result := make([]lessonReachSorted, 0, len(m))
	for _, lr := range m {
		result = append(result, *lr)
	}
	for i := 1; i < len(result); i++ {
		for j := i; j > 0 && result[j].Score > result[j-1].Score; j-- {
			result[j], result[j-1] = result[j-1], result[j]
		}
	}
	if len(result) > 15 {
		result = result[:15]
	}
	return result
}

package main

import (
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
)

// Hybrid retrieval fuses the vector (bge-base cosine) ranking with an FTS5
// keyword (bm25) ranking via Reciprocal Rank Fusion. The vector floor
// (ScoreFloor) misses bare identifier/token queries that never clear 0.70
// cosine (mission-umwj.1); the keyword side recovers them. RRF only orders;
// each hit keeps its real cosine Score so every downstream gate (0.70/0.85/
// 0.90+) is unchanged (mission-umwj.3). Requires -tags sqlite_fts5.
const (
	RRFK         = 60 // RRF damping constant (standard default)
	KwPool       = 20 // keyword candidates pulled from FTS per table
	KeywordKeep  = 3  // keyword-only hits admitted below the cosine floor
	maxFTSTokens = 32 // cap tokens so a pasted error dump can't explode the query
)

var ftsTok = regexp.MustCompile(`[\p{L}\p{N}_]+`)

// ftsQuery turns arbitrary text (including pasted error output) into a safe
// FTS5 OR-query of quoted, lowercased, de-duplicated tokens.
func ftsQuery(q string) string {
	seen := map[string]bool{}
	var parts []string
	for _, t := range ftsTok.FindAllString(strings.ToLower(q), -1) {
		if len(t) < 2 || seen[t] {
			continue
		}
		seen[t] = true
		parts = append(parts, `"`+t+`"`)
		if len(parts) == maxFTSTokens {
			break
		}
	}
	return strings.Join(parts, " OR ")
}

// keywordIDs returns up to k base-table IDs ordered by bm25 relevance for the
// FTS query. weights are the per-column bm25 weights (e.g. "2.0, 1.0" to favor
// the key/title column). Returns nil for an empty query.
func (s *Store) keywordIDs(table, idExpr, ftsTable, q string, weights string, k int) ([]string, error) {
	fq := ftsQuery(q)
	if fq == "" {
		return nil, nil
	}
	rows, err := s.db.Query(`SELECT `+idExpr+` FROM `+ftsTable+` f JOIN `+table+` t ON t.rowid = f.rowid
		WHERE `+ftsTable+` MATCH ? ORDER BY bm25(`+ftsTable+`, `+weights+`) LIMIT ?`, fq, k)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// cosine returns the raw cosine similarity (not distance) of a stored vector
// against emb, computed on demand for a keyword-only hit that was never in the
// vector top-k. Returns 0 if the key has no vector.
func (s *Store) cosine(vecTable, key string, emb []float32) (float64, error) {
	var d float64
	err := s.db.QueryRow(`SELECT vec_distance_cosine(embedding, ?) FROM `+vecTable+` WHERE key = ?`, float32ToBytes(emb), key).Scan(&d)
	return cosineDistToScore(d), err
}

type fused struct {
	id      string
	rrf     float64
	vecRank int // -1 if absent
	kwRank  int // -1 if absent
}

// fuse returns ids ordered by RRF, admitting every vector hit that passed the
// floor/tail-gap filter plus the top KeywordKeep keyword-only hits. A hit
// present in both rankings accumulates both reciprocal-rank contributions.
func fuse(vecAdmitted []string, kw []string) []fused {
	m := map[string]*fused{}
	get := func(id string) *fused {
		if f, ok := m[id]; ok {
			return f
		}
		f := &fused{id: id, vecRank: -1, kwRank: -1}
		m[id] = f
		return f
	}
	for i, id := range vecAdmitted {
		f := get(id)
		f.vecRank = i
		f.rrf += 1.0 / float64(RRFK+i+1)
	}
	for i, id := range kw {
		if _, ok := m[id]; !ok && i >= KeywordKeep {
			continue // keyword-only hit outside the top-KeywordKeep: drop
		}
		f := get(id)
		f.kwRank = i
		f.rrf += 1.0 / float64(RRFK+i+1)
	}
	out := make([]fused, 0, len(m))
	for _, f := range m {
		out = append(out, *f)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].rrf != out[j].rrf {
			return out[i].rrf > out[j].rrf
		}
		return out[i].id < out[j].id
	})
	return out
}

// matchLabel reports which ranking(s) surfaced a fused hit.
func matchLabel(f fused) string {
	switch {
	case f.vecRank >= 0 && f.kwRank >= 0:
		return "both"
	case f.kwRank >= 0:
		return "keyword"
	default:
		return "semantic"
	}
}

// fuseLessons reorders the floor-admitted vector lessons with the FTS keyword
// ranking via RRF and returns the fused list plus a semantic|keyword|both tier
// label per key. Keyword-only hits (never in the vector top-k) get their real
// cosine on demand and still respect the domain filter.
func (s *Store) fuseLessons(emb []float32, query, domain string, admitted []SearchHit) ([]SearchHit, map[string]string) {
	byKey := make(map[string]SearchHit, len(admitted))
	vk := make([]string, 0, len(admitted))
	for _, h := range admitted {
		byKey[h.Key] = h
		vk = append(vk, h.Key)
	}
	kw, err := s.keywordIDs("lessons", "t.key", "lesson_fts", query, "2.0, 1.0", KwPool)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fts lessons:", err)
	}
	tier := map[string]string{}
	var out []SearchHit
	for _, f := range fuse(vk, kw) {
		h, ok := byKey[f.id]
		if !ok {
			l, err := s.GetLessonByKey(f.id)
			if err != nil || l == nil || (domain != "" && l.Domain != domain) {
				continue
			}
			sc, _ := s.cosine("lesson_vec", f.id, emb)
			h = SearchHit{Key: l.Key, Text: l.Text, Domain: l.Domain, Score: sc}
		}
		tier[f.id] = matchLabel(f)
		out = append(out, h)
	}
	return out, tier
}

// fuseChildren is fuseLessons for mission children; keyword-only hits respect
// the kind filter.
func (s *Store) fuseChildren(emb []float32, query, kind string, admitted []ChildHit) ([]ChildHit, map[string]string) {
	byID := make(map[string]ChildHit, len(admitted))
	ck := make([]string, 0, len(admitted))
	for _, h := range admitted {
		byID[h.ID] = h
		ck = append(ck, h.ID)
	}
	kw, err := s.keywordIDs("mission_children", "t.id", "child_fts", query, "2.0, 1.0", KwPool)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fts children:", err)
	}
	tier := map[string]string{}
	var out []ChildHit
	for _, f := range fuse(ck, kw) {
		h, ok := byID[f.id]
		if !ok {
			var c ChildHit
			err := s.db.QueryRow(`SELECT id, mission_id, text, kind, status FROM mission_children WHERE id=?`, f.id).Scan(&c.ID, &c.MissionID, &c.Text, &c.Kind, &c.Status)
			if err != nil || (kind != "" && c.Kind != kind) {
				continue
			}
			c.Score, _ = s.cosine("child_vec", f.id, emb)
			h = c
		}
		tier[f.id] = matchLabel(f)
		out = append(out, h)
	}
	return out, tier
}

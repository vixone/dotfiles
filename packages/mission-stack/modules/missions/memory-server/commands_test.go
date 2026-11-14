package main

import (
	"encoding/json"
	"math"
	"path/filepath"
	"strings"
	"testing"
)

// TestFuseSearch_KeywordRecoversSubFloorAndTiers verifies hybrid fusion: a
// bare-identifier query that scores below the 0.70 cosine floor is still
// returned via the keyword side (tier=keyword), while a vector-admitted hit
// keeps its real cosine score and a semantic/both tier. Requires -tags
// sqlite_fts5.
func TestFuseSearch_KeywordRecoversSubFloorAndTiers(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "fuse.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()
	if err := store.InitSchema(); err != nil {
		t.Fatalf("init schema: %v", err)
	}

	q := make([]float32, EmbedDims)
	q[0] = 1 // query direction
	orth := make([]float32, EmbedDims)
	orth[1] = 1 // orthogonal to q -> cosine 0, below the floor

	lessons := []Lesson{
		{Key: "aurora-drift", Text: "aurora iopt1 drift reconcile checklist"},   // semantic only
		{Key: "dual-hit", Text: "trustedBaseImageSources tuning for karpenter"}, // vector + keyword
		{Key: "image-policy", Text: "trustedBaseImageSources admission policy"}, // keyword only (sub-floor)
	}
	embs := [][]float32{q, q, orth}
	if err := store.InsertLessons(lessons, embs); err != nil {
		t.Fatalf("insert lessons: %v", err)
	}

	admitted, err := store.SearchLessons(q, MaxLessons)
	if err != nil {
		t.Fatalf("search lessons: %v", err)
	}
	admitted = filterHits(admitted) // floor + tail gap: drops image-policy

	got, tier := store.fuseLessons(q, "trustedBaseImageSources", "", admitted)
	byKey := map[string]SearchHit{}
	for _, h := range got {
		byKey[h.Key] = h
	}

	// Keyword-only sub-floor hit is recovered with tier=keyword.
	ip, ok := byKey["image-policy"]
	if !ok {
		t.Fatalf("image-policy not recovered by keyword fusion; got keys %v", keysOf(got))
	}
	if tier["image-policy"] != "keyword" {
		t.Errorf("image-policy tier = %q, want keyword", tier["image-policy"])
	}
	if ip.Score >= ScoreFloor {
		t.Errorf("image-policy score %.3f should be below floor %.2f", ip.Score, ScoreFloor)
	}

	// Vector-admitted hit keeps its cosine score and a semantic tier.
	ad, ok := byKey["aurora-drift"]
	if !ok || tier["aurora-drift"] != "semantic" {
		t.Errorf("aurora-drift tier = %q (present=%v), want semantic", tier["aurora-drift"], ok)
	}
	if math.Abs(ad.Score-1.0) > 1e-5 {
		t.Errorf("aurora-drift score %.5f, want ~1.0 (cosine unchanged)", ad.Score)
	}

	// Hit in both rankings gets tier=both, cosine unchanged.
	dh, ok := byKey["dual-hit"]
	if !ok || tier["dual-hit"] != "both" {
		t.Errorf("dual-hit tier = %q (present=%v), want both", tier["dual-hit"], ok)
	}
	if math.Abs(dh.Score-1.0) > 1e-5 {
		t.Errorf("dual-hit score %.5f, want ~1.0", dh.Score)
	}
}

func keysOf(hits []SearchHit) []string {
	out := make([]string, len(hits))
	for i, h := range hits {
		out[i] = h.Key
	}
	return out
}

// --- Regression guards: behavior that is already correct and must stay so. ---

func TestCosineDistToScore(t *testing.T) {
	cases := []struct {
		dist float64
		want float64
	}{
		{0.0, 1.0},  // identical
		{1.0, 0.0},  // orthogonal
		{0.1, 0.9},  // near
		{0.06, 0.94},
	}
	for _, c := range cases {
		got := cosineDistToScore(c.dist)
		if math.Abs(got-c.want) > 1e-9 {
			t.Errorf("cosineDistToScore(%v) = %v, want %v", c.dist, got, c.want)
		}
	}
}

func TestFilterHits_ScoreFloorAndTailGap(t *testing.T) {
	// Below ScoreFloor (0.70) is dropped; a tail-gap > TailGap (0.05) truncates.
	hits := []SearchHit{
		{Key: "a", Score: 0.95},
		{Key: "b", Score: 0.93}, // within tail gap of a
		{Key: "c", Score: 0.80}, // gap 0.13 from b -> truncates here
		{Key: "d", Score: 0.60}, // below floor anyway
	}
	got := filterHits(hits)
	if len(got) != 2 {
		t.Fatalf("filterHits kept %d hits, want 2 (a,b); got %+v", len(got), got)
	}
	if got[0].Key != "a" || got[1].Key != "b" {
		t.Errorf("filterHits kept %v, want [a b]", []string{got[0].Key, got[1].Key})
	}
}

func TestFilterHits_AllBelowFloor(t *testing.T) {
	got := filterHits([]SearchHit{{Key: "a", Score: 0.5}, {Key: "b", Score: 0.4}})
	if len(got) != 0 {
		t.Errorf("filterHits kept %d, want 0 (all below floor)", len(got))
	}
}

func TestClassifyDomain(t *testing.T) {
	cases := map[string]string{
		"eks-nodegroup-taint":     "eks",
		"terraform-state-lock":    "terraform",
		"tf-import-onboard":       "terraform",
		"karpenter-drift":         "karpenter",
		"pi-jiti-symlink":         "pi",
		"something-unclassified":  "general",
	}
	for key, want := range cases {
		if got := classifyDomain(key); got != want {
			t.Errorf("classifyDomain(%q) = %q, want %q", key, got, want)
		}
	}
}

func TestTruncate(t *testing.T) {
	if got := truncate("first line\nsecond line", 200); got != "first line" {
		t.Errorf("truncate first-line = %q, want %q", got, "first line")
	}
	long := make([]byte, 250)
	for i := range long {
		long[i] = 'x'
	}
	if got := truncate(string(long), 200); len(got) != 203 { // 200 + "..."
		t.Errorf("truncate long len = %d, want 203", len(got))
	}
}

// TestDupTierConstants pins the passage-embedded duplicate tiers used by the
// check-dup command today. This is a regression guard on the CURRENT Go values.
func TestDupTierConstants(t *testing.T) {
	if DupMerge != 0.96 || DupLikely != 0.93 || DupRelated != 0.90 {
		t.Errorf("dup tiers = %.2f/%.2f/%.2f, expected current 0.96/0.93/0.90", DupMerge, DupLikely, DupRelated)
	}
}

// --- Unified duplicate verdict + versioned envelope (mission-927.8). ---

// The verdict is derived from ONE calibrated tier set. Preview (Markdown) and
// the write gate (JSON) both consume this, so they cannot disagree.
func TestResolveDuplicateCheck_ExistingKeyIsExplicit(t *testing.T) {
	exact := &Lesson{Key: "existing-key", Text: "stored lesson"}
	got := resolveDuplicateCheck("existing-key", nil, exact)
	if got.verdict != "existing_key" || got.topScore != 1 {
		t.Fatalf("existing key verdict=%q score=%v, want existing_key/1", got.verdict, got.topScore)
	}
	if len(got.relevant) != 0 {
		t.Fatalf("existing key leaked into similar matches: %+v", got.relevant)
	}
}

func TestResolveDuplicateCheck_ExactKeyDoesNotHideLaterMatch(t *testing.T) {
	matches := []DupMatch{
		{Key: "existing-key", Text: "stored lesson", Score: 0.99},
		{Key: "other-key", Text: "similar lesson", Score: 0.97},
	}
	exact := &Lesson{Key: "existing-key", Text: "stored lesson"}
	got := resolveDuplicateCheck("existing-key", matches, exact)
	if got.verdict != "existing_key" || len(got.relevant) != 1 || got.relevant[0].Key != "other-key" {
		t.Fatalf("exact key hid later match: %+v", got)
	}
}

func TestResolveDuplicateCheck_MissingKeyUsesSimilarity(t *testing.T) {
	matches := []DupMatch{{Key: "other-key", Text: "similar lesson", Score: 0.97}}
	got := resolveDuplicateCheck("new-key", matches, nil)
	if got.verdict != "merge" || got.topScore != 0.97 || len(got.relevant) != 1 {
		t.Fatalf("missing key result=%+v, want merge against other-key", got)
	}
}

func TestClassifyDupVerdict(t *testing.T) {
	cases := []struct {
		score float64
		want  string
	}{
		{0.97, "merge"},   // >= DupMerge (0.96)
		{0.96, "merge"},
		{0.94, "likely"},  // >= DupLikely (0.93)
		{0.93, "likely"},
		{0.91, "related"}, // >= DupRelated (0.90)
		{0.90, "related"},
		{0.80, "none"},
		{0.0, "none"},
	}
	for _, c := range cases {
		if got := classifyDupVerdict(c.score); got != c.want {
			t.Errorf("classifyDupVerdict(%.2f) = %q, want %q", c.score, got, c.want)
		}
	}
}

func TestCanonicalTiers_SingleSource(t *testing.T) {
	tiers := canonicalTiers()
	if tiers.Merge != DupMerge || tiers.Likely != DupLikely || tiers.Related != DupRelated {
		t.Errorf("canonicalTiers %+v must equal the Dup* consts", tiers)
	}
}

func TestEnvelope_CarriesContractAndIdentity(t *testing.T) {
	env := newEnvelope("search", "q")
	if env.ContractVersion != ContractVersion {
		t.Errorf("contract_version = %q, want %q", env.ContractVersion, ContractVersion)
	}
	if env.Model != ModelName || env.SchemaVersion != SchemaVersion || env.EmbedDims != EmbedDims {
		t.Errorf("envelope missing model/schema identity: %+v", env)
	}
	b, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(b), `"contract_version":"memory-v1"`) {
		t.Errorf("marshaled envelope lacks contract_version: %s", b)
	}
	// error field is always present (explicit null) so clients can detect it.
	if !strings.Contains(string(b), `"error":null`) {
		t.Errorf("envelope must serialize an explicit error field: %s", b)
	}
}

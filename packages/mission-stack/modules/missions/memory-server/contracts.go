package main

import (
	"encoding/json"
	"fmt"
)

// ContractVersion identifies the structured response schema. Bump when the
// envelope shape changes incompatibly; clients reject a mismatched version.
const ContractVersion = "memory-v1"

// Envelope is the versioned JSON response emitted with --json. Human Markdown
// output is produced separately (default, no --json). Every envelope carries
// the model + schema identity so a client can detect a stale or mismatched
// index, and an explicit error field so read failures are visible instead of
// masquerading as an empty (false-success) result.
type Envelope struct {
	ContractVersion string        `json:"contract_version"`
	Command         string        `json:"command"`
	Model           string        `json:"model"`
	EmbedDims       int           `json:"embed_dims"`
	SchemaVersion   string        `json:"schema_version"`
	SyncStatus      string        `json:"sync_status,omitempty"`
	Query           string        `json:"query,omitempty"`
	Filters         *Filters      `json:"filters,omitempty"`
	Hits            []JSONHit     `json:"hits,omitempty"`
	Missions        []JSONMission `json:"missions,omitempty"`
	Duplicate       *DupResult    `json:"duplicate,omitempty"`
	Status          *StatusInfo   `json:"status,omitempty"`
	Error           *EnvError     `json:"error"`
}

// StatusInfo is a read-only snapshot of index coverage + identity. Produced by
// --status without embedding or writing anything.
type StatusInfo struct {
	Indexed       bool   `json:"indexed"`
	Lessons       int    `json:"lessons"`
	Children      int    `json:"children"`
	Missions      int    `json:"missions"`
	SimilarEdges  int    `json:"similar_edges"`
	RelatedEdges  int    `json:"related_edges"`
	LastSyncTs    string `json:"last_sync_ts"`
	SyncStatus    string `json:"sync_status"`
	EmbedModel    string `json:"embed_model"`
	EmbedDims     string `json:"embed_dims"`
	IndexSchema   string `json:"index_schema_version"`
}

// Filters echoes the domain/kind filters that were applied.
type Filters struct {
	Domain string `json:"domain,omitempty"`
	Kind   string `json:"kind,omitempty"`
}

// JSONHit is a typed, full-precision search/duplicate hit.
type JSONHit struct {
	Type       string  `json:"type"` // "lesson" | "mission_child"
	Key        string  `json:"key"`
	Domain     string  `json:"domain,omitempty"`
	MissionID  string  `json:"mission_id,omitempty"`
	Kind       string  `json:"kind,omitempty"`
	Status     string  `json:"status,omitempty"`
	Score      float64 `json:"score"`
	Excerpt    string  `json:"excerpt"`
	Provenance string  `json:"provenance"`
	Tier       string  `json:"tier,omitempty"` // search: semantic|keyword|both; check-dup: existing_key
}

// JSONMission groups related-mission results.
type JSONMission struct {
	ID       string    `json:"id"`
	Title    string    `json:"title"`
	Status   string    `json:"status,omitempty"`
	TopScore float64   `json:"top_score"`
	Children []JSONHit `json:"children,omitempty"`
}

// DupTiers is the single calibrated tier set shared by preview and write gate.
type DupTiers struct {
	Merge   float64 `json:"merge"`
	Likely  float64 `json:"likely"`
	Related float64 `json:"related"`
}

// DupResult is the unified duplicate verdict. verdict is derived from the same
// passage-comparison scores and tier config that the human preview uses, so
// preview and the write gate never disagree. No merge is ever automatic: a
// "merge" verdict is advisory, the agent still decides.
type DupResult struct {
	ProposedKey string    `json:"proposed_key,omitempty"`
	Verdict     string    `json:"verdict"` // existing_key | merge | likely | related | none
	TopScore    float64   `json:"top_score"`
	Tiers       DupTiers  `json:"tiers"`
	Matches     []JSONHit `json:"matches"`
	ExactKey    *JSONHit  `json:"exact_key,omitempty"`
}

// EnvError is a visible, typed error (read outage, embed failure, etc.).
type EnvError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func canonicalTiers() DupTiers {
	return DupTiers{Merge: DupMerge, Likely: DupLikely, Related: DupRelated}
}

// classifyDupVerdict maps a top score to the shared verdict. Used by both the
// JSON check-dup response and (indirectly) the write gate, so the block
// decision is identical to the preview.
func classifyDupVerdict(topScore float64) string {
	switch {
	case topScore >= DupMerge:
		return "merge"
	case topScore >= DupLikely:
		return "likely"
	case topScore >= DupRelated:
		return "related"
	default:
		return "none"
	}
}

func newEnvelope(command, query string) Envelope {
	return Envelope{
		ContractVersion: ContractVersion,
		Command:         command,
		Model:           ModelName,
		EmbedDims:       EmbedDims,
		SchemaVersion:   SchemaVersion,
		Query:           query,
	}
}

// emitJSON marshals an envelope to stdout (pretty-printed for readability).
func emitJSON(env Envelope) error {
	b, err := json.MarshalIndent(env, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(b))
	return nil
}

// emitJSONError prints an error envelope for the given command so a read outage
// or embed failure is a visible diagnostic, not a silent empty result.
func emitJSONError(command, query, code string, cause error) {
	env := newEnvelope(command, query)
	env.Error = &EnvError{Code: code, Message: cause.Error()}
	_ = emitJSON(env)
}

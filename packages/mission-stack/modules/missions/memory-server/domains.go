package main

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// DomainRegistryVersion is the only accepted registry schema version.
const DomainRegistryVersion = 1

// FallbackDomain is assigned to lesson keys that match no registry prefix.
const FallbackDomain = "general"

// defaultDomainsJSON is the canonical bundled registry (memory-server/domains.json).
//
//go:embed domains.json
var defaultDomainsJSON []byte

var (
	domainPrefixPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)
	domainNamePattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)
)

// DomainEntry maps a lesson-key prefix to a domain.
type DomainEntry struct {
	Prefix string `json:"prefix"`
	Domain string `json:"domain"`
}

type domainRegistryFile struct {
	Version int           `json:"version"`
	Domains []DomainEntry `json:"domains"`
}

// DomainRegistry classifies lesson keys by longest matching prefix.
// A registry is a full replacement: entries absent from it are not inherited.
type DomainRegistry struct {
	entries []DomainEntry // sorted by prefix length desc, then prefix
}

// ParseDomainRegistry strictly decodes and validates registry JSON.
func ParseDomainRegistry(data []byte) (*DomainRegistry, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var f domainRegistryFile
	if err := dec.Decode(&f); err != nil {
		return nil, fmt.Errorf("decode domain registry: %w", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("domain registry: unexpected trailing input")
	}
	if f.Version != DomainRegistryVersion {
		return nil, fmt.Errorf("domain registry: version %d unsupported (want %d)", f.Version, DomainRegistryVersion)
	}
	if len(f.Domains) == 0 {
		return nil, errors.New("domain registry: domains must not be empty")
	}
	seen := make(map[string]bool, len(f.Domains))
	for i, e := range f.Domains {
		if !domainPrefixPattern.MatchString(e.Prefix) {
			return nil, fmt.Errorf("domain registry: entry %d: invalid prefix %q", i, e.Prefix)
		}
		if !domainNamePattern.MatchString(e.Domain) {
			return nil, fmt.Errorf("domain registry: entry %d: invalid domain %q", i, e.Domain)
		}
		if seen[e.Prefix] {
			return nil, fmt.Errorf("domain registry: duplicate prefix %q", e.Prefix)
		}
		seen[e.Prefix] = true
	}
	entries := append([]DomainEntry(nil), f.Domains...)
	sort.Slice(entries, func(i, j int) bool {
		if len(entries[i].Prefix) != len(entries[j].Prefix) {
			return len(entries[i].Prefix) > len(entries[j].Prefix)
		}
		return entries[i].Prefix < entries[j].Prefix
	})
	return &DomainRegistry{entries: entries}, nil
}

// DefaultDomainRegistry returns the bundled registry.
func DefaultDomainRegistry() (*DomainRegistry, error) {
	return ParseDomainRegistry(defaultDomainsJSON)
}

// LoadDomainRegistryFile reads and validates a registry file.
func LoadDomainRegistryFile(path string) (*DomainRegistry, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read domain registry: %w", err)
	}
	reg, err := ParseDomainRegistry(data)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return reg, nil
}

// ResolveDomainRegistry picks the runtime registry: an explicit path must
// exist; otherwise the installed path is used when present, else the bundled
// defaults. Returns the registry and its source ("bundled" or a file path).
func ResolveDomainRegistry(explicitPath, installedPath string) (*DomainRegistry, string, error) {
	if explicitPath != "" {
		reg, err := LoadDomainRegistryFile(explicitPath)
		return reg, explicitPath, err
	}
	if installedPath != "" {
		if _, err := os.Stat(installedPath); err == nil {
			reg, err := LoadDomainRegistryFile(installedPath)
			return reg, installedPath, err
		} else if !os.IsNotExist(err) {
			return nil, installedPath, fmt.Errorf("stat domain registry: %w", err)
		}
	}
	reg, err := DefaultDomainRegistry()
	return reg, "bundled", err
}

// defaultInstalledDomainsPath is the editable installed registry location.
func defaultInstalledDomainsPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".pi", "agent", "knowledge", "domains.json")
}

// Classify returns the domain of the longest matching prefix, or FallbackDomain.
func (r *DomainRegistry) Classify(key string) string {
	for _, e := range r.entries {
		if strings.HasPrefix(key, e.Prefix) {
			return e.Domain
		}
	}
	return FallbackDomain
}

// classifyDomain classifies with the bundled defaults (compatibility wrapper).
func classifyDomain(key string) string {
	reg, err := DefaultDomainRegistry()
	if err != nil {
		return FallbackDomain
	}
	return reg.Classify(key)
}

// BackfillResult reports a metadata-only domain backfill.
type BackfillResult struct {
	Scanned         int            `json:"scanned"`
	Changed         int            `json:"changed"`
	ChangedByDomain map[string]int `json:"changed_by_domain"`
}

// runBackfillDomains reclassifies lessons.domain for every indexed lesson in an
// EXISTING index, in one transaction. It never creates the database and never
// touches text, hash, vectors, children, edges or meta.
func runBackfillDomains(dbPath string, reg *DomainRegistry) (BackfillResult, error) {
	if _, err := os.Stat(dbPath); err != nil {
		return BackfillResult{}, fmt.Errorf("backfill requires an existing index at %s: %w", dbPath, err)
	}
	store, err := OpenExistingStore(dbPath)
	if err != nil {
		return BackfillResult{}, fmt.Errorf("open db: %w", err)
	}
	defer store.Close()
	ok, err := store.tableExists("lessons")
	if err != nil {
		return BackfillResult{}, fmt.Errorf("inspect db: %w", err)
	}
	if !ok {
		return BackfillResult{}, fmt.Errorf("%s has no lessons table; not a memory index", dbPath)
	}
	res, err := store.RefreshLessonDomains(reg.Classify)
	if err != nil {
		return res, err
	}
	if res.Changed > 0 {
		if err := store.Checkpoint(); err != nil {
			return res, fmt.Errorf("checkpoint: %w", err)
		}
	}
	return res, nil
}

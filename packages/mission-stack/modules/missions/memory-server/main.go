package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

const (
	EmbedDims     = 768
	ModelName     = "bge-base-en-v1.5"
	SchemaVersion = "2"
)

func defaultDBPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".pi", "state", "memory.db")
}

func defaultModelCache() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".pi", "state", "models")
}

func main() {
	// Subcommands via flags (match Python CLI interface)
	searchCmd := flag.String("search", "", "Search memory for a query")
	checkDupCmd := flag.String("check-dup", "", "Check if text is a duplicate lesson")
	keyFlag := flag.String("key", "", "Proposed key for check-dup (excludes self-match)")
	relatedCmd := flag.String("related", "", "Find related missions for a query")
	blastCmd := flag.String("blast-radius", "", "Show blast radius for a mission ID")
	syncCmd := flag.Bool("sync", false, "Full re-sync from mx.db lessons and mission children")
	statusCmd := flag.Bool("status", false, "Read-only coverage + identity snapshot (no embed, no write)")
	syncIncrCmd := flag.Bool("sync-incremental", false, "Incremental sync: embed only new lessons/children")
	addLessonCmd := flag.String("add-lesson", "", "Index a single lesson by key (reads mx.db, embeds, inserts)")
	addChildrenCmd := flag.String("add-children", "", "Index new children for a mission ID (diffs against DB)")
	dbPath := flag.String("db", "", "Path to sqlite-vec database (default: ~/.pi/state/memory.db)")
	modelDir := flag.String("model-dir", "", "Path to model cache (default: ~/.pi/state/models)")
	jsonOut := flag.Bool("json", false, "Emit versioned JSON (contract memory-v1) instead of human Markdown")
	domainFilter := flag.String("domain", "", "Filter search lessons to a domain (native, no top-k truncation loss)")
	domainsFile := flag.String("domains-file", "", "Domain registry JSON (default: ~/.pi/agent/knowledge/domains.json if present, else bundled defaults); must exist when given")
	backfillCmd := flag.Bool("backfill-domains", false, "Metadata-only: reclassify lessons.domain in the EXISTING index using the domain registry (no embed, no mx.db read)")
	validateDomainsCmd := flag.Bool("validate-domains", false, "Validate the domain registry that would be used and exit")
	kindFilter := flag.String("type", "", "Filter search mission children to a kind (finding/decision/action)")

	flag.Parse()

	db := *dbPath
	if db == "" {
		db = os.Getenv("MEMORY_SQLITE_PATH")
		if db == "" {
			db = defaultDBPath()
		}
	}

	cache := *modelDir
	if cache == "" {
		cache = os.Getenv("MEMORY_MODEL_DIR")
		if cache == "" {
			cache = defaultModelCache()
		}
	}

	// Commands that classify lessons resolve + validate the registry before any
	// DB access, so a missing explicit file or malformed registry fails first.
	var reg *DomainRegistry
	if *validateDomainsCmd || *backfillCmd || *syncCmd || *syncIncrCmd || *addLessonCmd != "" {
		r, src, err := ResolveDomainRegistry(*domainsFile, defaultInstalledDomainsPath())
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: domain registry (%s): %v\n", src, err)
			os.Exit(1)
		}
		reg = r
		if *validateDomainsCmd {
			fmt.Printf("✓ domain registry valid (%s)\n", src)
			return
		}
	}

	if *backfillCmd {
		res, err := runBackfillDomains(db, reg)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
		printBackfillResult(res, *jsonOut)
		return
	}

	// Ensure state directory exists
	os.MkdirAll(filepath.Dir(db), 0755)

	var err error
	switch {
	case *searchCmd != "":
		err = runSearch(db, cache, *searchCmd, *jsonOut, *domainFilter, *kindFilter)
	case *checkDupCmd != "":
		err = runCheckDup(db, cache, *checkDupCmd, *keyFlag, *jsonOut)
	case *relatedCmd != "":
		err = runRelated(db, cache, *relatedCmd, *jsonOut)
	case *blastCmd != "":
		err = runBlastRadius(db, cache, *blastCmd, *jsonOut)
	case *statusCmd:
		err = runStatus(db, *jsonOut)
	case *syncCmd:
		err = runSync(db, cache, reg)
	case *syncIncrCmd:
		err = runSyncIncremental(db, cache, reg)
	case *addLessonCmd != "":
		err = runAddLesson(db, cache, *addLessonCmd, reg)
	case *addChildrenCmd != "":
		err = runAddChildren(db, cache, *addChildrenCmd)
	default:
		fmt.Fprintf(os.Stderr, "Usage: memory-server --search <query> | --check-dup <text> [--key <key>] | --related <query> | --blast-radius <mission-id> | --sync | --add-lesson <key> | --add-children <mission-id> | --backfill-domains | --validate-domains [--domains-file <path>]\n")
		os.Exit(1)
	}

	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

func printBackfillResult(res BackfillResult, jsonOut bool) {
	if jsonOut {
		out, _ := json.Marshal(res)
		fmt.Println(string(out))
		return
	}
	fmt.Printf("✓ Domain backfill: scanned %d, changed %d\n", res.Scanned, res.Changed)
	domains := make([]string, 0, len(res.ChangedByDomain))
	for d := range res.ChangedByDomain {
		domains = append(domains, d)
	}
	sort.Strings(domains)
	for _, d := range domains {
		fmt.Printf("    -> %s: %d\n", d, res.ChangedByDomain[d])
	}
}

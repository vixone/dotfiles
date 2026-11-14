package main

// Read-only access to the mx mission store (~/.missions/mx.db, or MX_DB).
// mx is the only writer; this server only reads lessons, epics and children
// straight from SQLite instead of spawning a CLI per query.

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
)

// mxSchemaVersion is the mx store schema this server understands.
const mxSchemaVersion = "1"

// mxDBPath resolves MX_DB, else ~/.missions/mx.db.
func mxDBPath() (string, error) {
	if p := os.Getenv("MX_DB"); p != "" {
		return p, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home for mx.db: %w", err)
	}
	return filepath.Join(home, ".missions", "mx.db"), nil
}

// openMx opens the mx store read-only and checks its schema version.
func openMx() (*sql.DB, error) {
	path, err := mxDBPath()
	if err != nil {
		return nil, err
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(abs); err != nil {
		return nil, fmt.Errorf("mx store %s: %w (set MX_DB or run mx import)", abs, err)
	}
	uri := url.URL{Scheme: "file", Path: abs}
	uri.RawQuery = "mode=ro&_busy_timeout=5000"
	db, err := sql.Open("sqlite3", uri.String())
	if err != nil {
		return nil, err
	}
	var version string
	if err := db.QueryRow(`select value from meta where key='schema_version'`).Scan(&version); err != nil {
		db.Close()
		return nil, fmt.Errorf("mx store %s: read schema_version: %w", abs, err)
	}
	if version != mxSchemaVersion {
		db.Close()
		return nil, fmt.Errorf("mx store %s has schema_version %s, memory-server supports %s", abs, version, mxSchemaVersion)
	}
	return db, nil
}

// labelsExpr is a correlated subquery yielding an issue's labels as a sorted
// JSON array, e.g. ["finding","memory"].
const labelsExpr = `coalesce((select json_group_array(label) from
	(select label from labels l where l.issue_id = i.id order by label)), '[]')`

func scanLabels(raw string) ([]string, error) {
	var labels []string
	if err := json.Unmarshal([]byte(raw), &labels); err != nil {
		return nil, fmt.Errorf("parse labels %q: %w", raw, err)
	}
	return labels, nil
}

// mxRecall returns one lesson's text; a missing key is an error.
func mxRecall(key string) (string, error) {
	db, err := openMx()
	if err != nil {
		return "", err
	}
	defer db.Close()
	var text string
	err = db.QueryRow(`select text from memories where key = ?`, key).Scan(&text)
	if err == sql.ErrNoRows {
		return "", fmt.Errorf("no lesson with key %q in mx store", key)
	}
	return text, err
}

// mxChildren returns the direct children of one mission.
func mxChildren(missionID string) ([]childRow, error) {
	db, err := openMx()
	if err != nil {
		return nil, err
	}
	defer db.Close()
	rows, err := db.Query(`select i.id, i.title, i.description, i.issue_type, i.status, `+labelsExpr+`
		from issues i where i.parent_id = ? order by i.id`, missionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []childRow
	for rows.Next() {
		var r childRow
		var labels string
		if err := rows.Scan(&r.ID, &r.Title, &r.Description, &r.Type, &r.Status, &labels); err != nil {
			return nil, err
		}
		if r.Labels, err = scanLabels(labels); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"

VAULT_DIR="${HOME}/obsidian-notes"
TEMPLATE="${VAULT_DIR}/templates/daily-note.md"
RUNS="${1:-8}"

YEAR=$(date +%Y)
DAY=$(date +%d)
MONTH_LOWER=$(date +%B | tr '[:upper:]' '[:lower:]')
DAY_NAME=$(date +%A)
FULL_DATE=$(date +%Y-%m-%d)

NOTE_DIR="${VAULT_DIR}/daily-notes/${YEAR}"
NOTE_FILE="${NOTE_DIR}/${DAY}-${MONTH_LOWER}.md"

mkdir -p "${NOTE_DIR}"
if [ ! -f "${NOTE_FILE}" ]; then
  sed -e "s/{{DATE}}/${FULL_DATE}/g" \
      -e "s/{{DAY}}/${DAY_NAME}/g" \
      "${TEMPLATE}" > "${NOTE_FILE}"
fi

if ! command -v nvim >/dev/null 2>&1; then
  echo "nvim not found in PATH" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found in PATH" >&2
  exit 1
fi

NOTE_FILE="${NOTE_FILE}" VAULT_DIR="${VAULT_DIR}" RUNS="${RUNS}" python3 - <<'PY'
import os
import subprocess
import time
import statistics

runs = int(os.environ["RUNS"])
vault_dir = os.environ["VAULT_DIR"]
note_file = os.environ["NOTE_FILE"]
values = []

for _ in range(runs):
    start = time.perf_counter()
    proc = subprocess.run(
        ["nvim", "--headless", note_file, "+qa"],
        cwd=vault_dir,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if proc.returncode == 0:
        values.append((time.perf_counter() - start) * 1000)

if not values:
    print("full_default: no successful runs")
else:
    print(
        f"full_default: runs={len(values)} "
        f"mean_ms={statistics.mean(values):.1f} "
        f"median_ms={statistics.median(values):.1f} "
        f"min_ms={min(values):.1f} "
        f"max_ms={max(values):.1f}"
    )
PY

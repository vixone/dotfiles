#!/usr/bin/env bash
# parity.sh - diff bd and mx on the read contract callers depend on
# (mission-xbdo.5). Run against a COPY of the beads store and an mx db
# imported from that same copy:
#
#   rsync -a --exclude backup ~/.missions/.beads/ /tmp/parity/.beads/
#   MX_DB=/tmp/parity/mx.db mx import --from-beads /tmp/parity/.beads/embeddeddolt/mission
#   BEADS_DIR=/tmp/parity/.beads MX_DB=/tmp/parity/mx.db ./parity.sh
#
# Exits 1 if any command differs in normalized output or exit code.
#
# Intentional differences, not checked here:
#   - Row order. Arrays are sorted by id before diffing; mx orders children by
#     numeric suffix, bd does not.
#   - Actors. bd takes git user.name from the cwd repo, mx uses $USER.
#     Comment authors, created_by and assignee are not compared.
#   - Batch close of an issue blocked by an open issue outside the batch: bd
#     skips it and exits 0, mx refuses it and exits 1.
#   - show expands dependencies to full issues in both tools; only {id,
#     dependency_type} is compared.
#   - search rows: mx includes parent, bd omits it (no caller reads it).
#   - show of a missing id: bd prints an error object on stdout, mx prints to
#     stderr. Both exit 1; only the exit code is compared.
#   - history: bd returns Dolt commits, mx returns its events table.
set -uo pipefail

: "${BEADS_DIR:?set BEADS_DIR to the beads copy}"
: "${MX_DB:?set MX_DB to the mx db imported from that copy}"
BD="${BD:-bd}"
MX="${MX:-mx}"
HERE="$(cd "$(dirname "$0")" && pwd)"
NORM="$HERE/normalize.jq"
OUT="${PARITY_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/mx-parity.XXXXXX")}"
mkdir -p "$OUT"
export BEADS_ACTOR=parity

q() { sqlite3 "$MX_DB" "$1"; }

# Samples, picked from the store so they cover edge cases.
SHOW_IDS=(
  $(q "select id from issues where issue_type='epic' order by (select count(*) from issues c where c.parent_id=issues.id) desc limit 1")
  $(q "select issue_id from deps where type='blocks' order by issue_id limit 1")
  $(q "select issue_id from comments group by issue_id order by count(*) desc limit 1")
  $(q "select id from issues where status='closed' and close_reason is not null and parent_id is not null order by closed_at desc limit 1")
  $(q "select id from issues where status='in_progress' order by updated_at desc limit 1")
)
EPICS=($(q "select id from issues where issue_type='epic' order by (select count(*) from issues c where c.parent_id=issues.id) desc, id limit 5"))
KEYS=(
  $(q "select key from memories order by key limit 1")
  $(q "select key from memories order by key limit 1 offset (select count(*)/2 from memories)")
  $(q "select key from memories order by key desc limit 1")
)

fail=0
n=0
printf '%-4s %-62s %7s %7s  %s\n' "#" "command" "bd" "mx" "result"
check() {
    local mode="$1"; shift
    n=$((n + 1))
    local tag
    tag="$(printf '%02d' "$n")"
    local bd_out mx_out bd_rc mx_rc
    bd_out="$("$BD" "$@" 2>"$OUT/$tag.bd.err")"; bd_rc=$?
    mx_out="$("$MX" "$@" 2>"$OUT/$tag.mx.err")"; mx_rc=$?
    if [[ "$mode" == rc ]]; then
        : >"$OUT/$tag.bd"; : >"$OUT/$tag.mx"   # exit code only
    elif [[ "$mode" == raw ]]; then
        printf '%s\n' "$bd_out" >"$OUT/$tag.bd"
        printf '%s\n' "$mx_out" >"$OUT/$tag.mx"
    else
        printf '%s' "$bd_out" | jq -S --arg mode "$mode" -f "$NORM" >"$OUT/$tag.bd" 2>>"$OUT/$tag.bd.err" || echo '"<bd: invalid json>"' >"$OUT/$tag.bd"
        printf '%s' "$mx_out" | jq -S --arg mode "$mode" -f "$NORM" >"$OUT/$tag.mx" 2>>"$OUT/$tag.mx.err" || echo '"<mx: invalid json>"' >"$OUT/$tag.mx"
    fi
    local size_bd size_mx
    if [[ "$mode" == raw || "$mode" == rc ]]; then
        size_bd="${#bd_out}"; size_mx="${#mx_out}"
    else
        size_bd="$(jq 'if type=="array" or type=="object" then length else 1 end' "$OUT/$tag.bd" 2>/dev/null || echo '?')"
        size_mx="$(jq 'if type=="array" or type=="object" then length else 1 end' "$OUT/$tag.mx" 2>/dev/null || echo '?')"
    fi
    local result="ok"
    if [[ "$bd_rc" -ne "$mx_rc" ]]; then
        result="EXIT bd=$bd_rc mx=$mx_rc"
    elif ! diff -u "$OUT/$tag.bd" "$OUT/$tag.mx" >"$OUT/$tag.diff"; then
        result="DIFF $OUT/$tag.diff"
    else
        rm -f "$OUT/$tag.diff"
    fi
    [[ "$result" == ok ]] || fail=1
    printf '%-4s %-62.62s %7s %7s  %s\n' "$tag" "$*" "$size_bd" "$size_mx" "$result"
}

check rows list --type epic --status open,in_progress,blocked,deferred --limit 0 --json
check rows list --type epic --all --limit 0 --json
check rows list --all --limit 0 --json
check rows list --status open,in_progress,blocked,deferred --limit 0 --json
check rows list --json
for id in "${SHOW_IDS[@]}"; do
    check show show "$id" --json
done
check show show "${SHOW_IDS[2]}" --include-comments --json
check rc show mission-zzzz-missing --json
for e in "${EPICS[@]}"; do
    check rows children "$e" --json
done
check ready ready --limit 0 --json
check ready ready --json
check search search sidebar --status all --type epic --json
check search search mission --limit 0 --json
check memories memories --json
for k in "${KEYS[@]}"; do
    check raw recall "$k"
done
check rc recall no-such-memory-key

echo ""
if [[ "$fail" -eq 0 ]]; then
    echo "PARITY OK ($n checks). Outputs in $OUT"
else
    echo "PARITY FAILED. Diffs in $OUT"
fi
exit "$fail"

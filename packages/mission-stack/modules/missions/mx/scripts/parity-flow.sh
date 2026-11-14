#!/usr/bin/env bash
# parity-flow.sh - replay a wayfinder session's writes with bd and with mx on
# fresh copies, then diff the final state and the per-step exit codes.
#
#   SRC_BEADS=/tmp/parity/.beads SRC_MX=/tmp/parity/mx.db ./parity-flow.sh
#
# SRC_MX must be an mx import of SRC_BEADS. Neither source is modified: the
# script works on copies in a temp dir. Exits 1 on any difference.
#
# Compared: titles, labels, statuses, parents, dependency targets, notes,
# close reasons, the ready sets and every step's exit code. Not compared:
# ids of the new epic (both are replaced by "E"), timestamps, actors.
set -uo pipefail

: "${SRC_BEADS:?set SRC_BEADS to a beads dir copy}"
: "${SRC_MX:?set SRC_MX to an mx db imported from it}"
BD="${BD:-bd}"
MX="${MX:-mx}"
HERE="$(cd "$(dirname "$0")" && pwd)"
NORM="$HERE/normalize.jq"
WORK="${PARITY_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/mx-parity-flow.XXXXXX")}"
mkdir -p "$WORK/bd" "$WORK/mx"
export BEADS_ACTOR=parity USER=parity

rsync -a --exclude backup "$SRC_BEADS/" "$WORK/beads/"
rm -f "$WORK/mx.db"
sqlite3 "$SRC_MX" "vacuum into '$WORK/mx.db'"

now() { perl -MTime::HiRes=time -e 'printf "%.3f", time'; }

# run NAME CMD... : stdout/stderr to $D/NAME.{out,err}, exit code to $D/rc.
run() {
    local name="$1"; shift
    "$@" >"$D/$name.out" 2>"$D/$name.err"
    echo "$name $?" >>"$D/rc"
}
# run_in NAME INPUT CMD... : same, with INPUT on stdin.
run_in() {
    local name="$1" input="$2"; shift 2
    printf '%s' "$input" | "$@" >"$D/$name.out" 2>"$D/$name.err"
    echo "$name $?" >>"$D/rc"
}
out() { tr -d '\n' <"$D/$1.out"; }

flow() {
    local T="$1"
    D="$WORK/$2"
    : >"$D/rc"
    run epic "$T" create "Parity flow epic" --type epic --labels parity,flow -p 1 --silent
    local E; E="$(out epic)"
    echo "$E" >"$D/epic_id"
    run_in design $'design line 1\ndesign line 2\n' "$T" update "$E" --design-file -

    local q
    for q in 1 2 3; do
        run "q$q" "$T" create "[question] Q$q" --parent "$E" --no-inherit-labels --labels flow,question -d "q$q body" --silent
    done
    run dep_q2 "$T" dep add "$(out q2)" "$(out q1)"
    run dep_q3 "$T" dep add "$(out q3)" "$(out q2)"

    run ready1 "$T" ready --parent "$E" --label question --unassigned --json
    local first; first="$(jq -r '.[0].id' "$D/ready1.out")"
    run claim "$T" update "$first" --claim --json
    run retitle "$T" update "$first" --title "[decision] Q1 resolved" --remove-label question --add-label decision -d "decided"
    run close "$T" close "$first" --reason "Resolved"
    run note "$T" note "$E" "Route - parity flow"
    run comment "$T" comment "$E" "Flow comment"

    local a
    for a in 1 2 3; do
        run "a$a" "$T" create "[action] A$a" --parent "$E" --labels action -d "a$a body" --json
        jq -r .id "$D/a$a.out" >"$D/a$a.id"
    done
    run dep_a2 "$T" dep add "$(cat "$D/a2.id")" "$(cat "$D/a1.id")"
    run dep_a3 "$T" dep add "$(cat "$D/a3.id")" "$(cat "$D/a2.id")"

    run show_e "$T" show "$E" --include-comments --json
    run children "$T" children "$E" --json
    run ready2 "$T" ready --parent "$E" --json
    local c
    for c in $(jq -r '.[].id' "$D/children.out"); do
        run "show_${c##*.}" "$T" show "$c" --json
    done
}

normalize_tool() {
    local tool="$1" D="$WORK/$1"
    local E; E="$(cat "$D/epic_id")"
    local shows=()
    local f
    for f in "$D"/show_*.out; do shows+=("$f"); done
    jq -n -S --arg e "$E" \
        --rawfile rc "$D/rc" \
        --slurpfile ready1 <(jq -S --arg mode ready -f "$NORM" "$D/ready1.out") \
        --slurpfile ready2 <(jq -S --arg mode ready -f "$NORM" "$D/ready2.out") \
        --slurpfile children <(jq -S --arg mode rows -f "$NORM" "$D/children.out") \
        --slurpfile shows <(cat "${shows[@]}" | jq -s -S 'map(.[0])' | jq -S --arg mode show -f "$NORM") \
        '{
           rc: ($rc | split("\n") | map(select(length > 0) | split(" ") | {(.[0]): (.[1] | tonumber)}) | add),
           ready1: $ready1[0], ready2: $ready2[0], children: $children[0],
           shows: ($shows[0] | map(del(.created_at, .comments) + {comments: ((.comments // []) | map(.text))}) | sort_by(.id))
         }
         | walk(if type == "string" then gsub($e; "E") else . end)' >"$WORK/$tool.final.json"
}

t0="$(now)"; flow "$BD" bd; t1="$(now)"
flow "$MX" mx; t2="$(now)"
normalize_tool bd
normalize_tool mx

echo "bd wall time: $(echo "$t1 - $t0" | bc) s"
echo "mx wall time: $(echo "$t2 - $t1" | bc) s"
if diff -u "$WORK/bd.final.json" "$WORK/mx.final.json" >"$WORK/final.diff"; then
    echo "FLOW PARITY OK ($(jq '.rc | length' "$WORK/mx.final.json") steps). Work dir: $WORK"
    exit 0
fi
echo "FLOW PARITY FAILED: $WORK/final.diff"
head -60 "$WORK/final.diff"
exit 1

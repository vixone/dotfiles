#!/usr/bin/env bash
set -euo pipefail

# install.sh - Install the mission-stack pi package safely.
#
# Skills and extensions are NOT copied: this checkout is registered in
# ~/.pi/agent/settings.json as a local pi package, so pi loads modules/*/skills
# and modules/*/extensions/*/index.ts straight from here (edits are live after
# /reload). This script only handles what pi packages can't: the memory-server
# binary, the mx mission-store CLI, ~/Missions.md, scripts and the domain
# registry.
#
# Safety contract (mission-927.12):
#   - Build + validate the memory-server FIRST into a temp file. If the build
#     fails, ABORT before touching anything: the previous install stays intact
#     and no stale binary is ever copied in.
#   - Preserve personal edits: the domain registry (knowledge/domains.json)
#     and ~/Missions.md are seeded only when missing, never overwritten. The registry the runtime will use is validated before any
#     install change.
#   - Record version + binary hash to an install manifest, and keep the prior
#     binary for rollback (restored automatically if a later step fails).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
BIN_DIR="$HOME/.pi/bin"
MISSIONS_DIR="$SCRIPT_DIR/modules/missions"
MANIFEST="$AGENT_DIR/mission-stack.install.json"

echo "Installing mission-stack from: $SCRIPT_DIR"
echo "Target: $AGENT_DIR"
echo ""

# --- 1. Build + validate the binary FIRST (abort on failure). --------------
if ! command -v go >/dev/null 2>&1; then
    echo "✗ Go toolchain not found. Cannot build memory-server. Aborting (previous install untouched)." >&2
    exit 1
fi

TMP_BIN="$(mktemp "${TMPDIR:-/tmp}/memory-server.XXXXXX")"
TMP_MX=""
cleanup_tmp() { rm -f "$TMP_BIN"; [[ -n "$TMP_MX" ]] && rm -f "$TMP_MX"; return 0; }
trap cleanup_tmp EXIT

echo "  Building memory-server..."
if ! (cd "$MISSIONS_DIR/memory-server" && go build -tags sqlite_fts5 -o "$TMP_BIN" . ); then
    echo "✗ memory-server build failed. Aborting install; previous install left intact." >&2
    exit 1
fi
if [[ ! -s "$TMP_BIN" ]]; then
    echo "✗ Build produced no binary. Aborting." >&2
    exit 1
fi
if command -v shasum >/dev/null 2>&1; then
    NEW_HASH="$(shasum -a 256 "$TMP_BIN" | awk '{print $1}')"
else
    NEW_HASH="$(sha256sum "$TMP_BIN" | awk '{print $1}')"
fi
echo "  ✓ built (sha256 ${NEW_HASH:0:12}…)"

# --- 1b. Validate the domain registry the runtime will use, BEFORE touching
# the install. An existing personal registry wins; otherwise the bundled seed.
DOMAINS_DEST="$AGENT_DIR/knowledge/domains.json"
DOMAINS_SEED="$MISSIONS_DIR/memory-server/domains.json"
if [[ -e "$DOMAINS_DEST" ]]; then DOMAINS_CHECK="$DOMAINS_DEST"; else DOMAINS_CHECK="$DOMAINS_SEED"; fi
if ! "$TMP_BIN" --validate-domains --domains-file "$DOMAINS_CHECK"; then
    echo "✗ Domain registry invalid: $DOMAINS_CHECK. Fix it and rerun; previous install left intact." >&2
    exit 1
fi

# --- 1c. Build + validate mx (Rust). Same rule: abort before any change. ---
# The crate's own target dir keeps rebuilds incremental; MX_TARGET_DIR
# overrides it (tests). Behind a TLS-intercepting proxy, set
# CARGO_HTTP_PROXY before running ./install.sh
CARGO_BIN="$(command -v cargo || true)"
if [[ -z "$CARGO_BIN" && -x "$HOME/.cargo/bin/cargo" ]]; then CARGO_BIN="$HOME/.cargo/bin/cargo"; fi
if [[ -z "$CARGO_BIN" ]]; then
    echo "✗ Cargo toolchain not found. Cannot build mx. Aborting (previous install untouched)." >&2
    exit 1
fi
MX_TARGET="${MX_TARGET_DIR:-$MISSIONS_DIR/mx/target}"
TMP_MX="$(mktemp "${TMPDIR:-/tmp}/mx.XXXXXX")"
echo "  Building mx..."
if ! "$CARGO_BIN" build --release --locked --manifest-path "$MISSIONS_DIR/mx/Cargo.toml" --target-dir "$MX_TARGET" --quiet; then
    echo "✗ mx build failed. Aborting install; previous install left intact." >&2
    exit 1
fi
cp "$MX_TARGET/release/mx" "$TMP_MX"
chmod +x "$TMP_MX"
if ! MX_VERSION="$("$TMP_MX" version)"; then
    echo "✗ Built mx does not run ('mx version' failed). Aborting; previous install left intact." >&2
    exit 1
fi
if command -v shasum >/dev/null 2>&1; then
    MX_HASH="$(shasum -a 256 "$TMP_MX" | awk '{print $1}')"
else
    MX_HASH="$(sha256sum "$TMP_MX" | awk '{print $1}')"
fi
echo "  ✓ built $MX_VERSION (sha256 ${MX_HASH:0:12}…)"

# --- 2. Rollback trap: restore the previous binaries if a later step fails. -
mkdir -p "$BIN_DIR" "$HOME/.local/bin"
BACKED_UP=0
if [[ -f "$BIN_DIR/memory-server" ]]; then
    cp "$BIN_DIR/memory-server" "$BIN_DIR/memory-server.prev"
    BACKED_UP=1
fi
MX_DEST="$HOME/.local/bin/mx"
MX_BACKED_UP=0
if [[ -f "$MX_DEST" ]]; then
    cp "$MX_DEST" "$MX_DEST.prev"
    MX_BACKED_UP=1
fi
rollback() {
    echo "✗ Install failed after build; rolling back." >&2
    if [[ "$BACKED_UP" -eq 1 && -f "$BIN_DIR/memory-server.prev" ]]; then
        mv -f "$BIN_DIR/memory-server.prev" "$BIN_DIR/memory-server"
        echo "  restored previous memory-server binary" >&2
    fi
    if [[ "$MX_BACKED_UP" -eq 1 && -f "$MX_DEST.prev" ]]; then
        cp -f "$MX_DEST.prev" "$MX_DEST"
        echo "  restored previous mx binary" >&2
    fi
    cleanup_tmp
}
trap 'rollback' ERR

# --- 3. Register this checkout as a local pi package. ----------------------
SETTINGS="$AGENT_DIR/settings.json"
mkdir -p "$AGENT_DIR"
node - "$SETTINGS" "$SCRIPT_DIR" <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const [settings, dir] = process.argv.slice(2);
const pkg = fs.realpathSync(dir);
const data = fs.existsSync(settings) ? JSON.parse(fs.readFileSync(settings, "utf8")) : {};
const pkgs = Array.isArray(data.packages) ? data.packages : [];
const base = path.dirname(settings);
const localPath = (entry) => {
  const src = typeof entry === "object" && entry !== null ? entry.source : entry;
  if (typeof src !== "string" || src.split("/")[0].includes(":")) return undefined;
  const abs = path.resolve(base, src.replace(/^~(?=$|\/)/, os.homedir()));
  try { return fs.realpathSync(abs); } catch { return abs; }
};
if (pkgs.some((e) => localPath(e) === pkg)) {
  console.log(`  ✓ pi package already registered (${pkg})`);
} else {
  pkgs.push(pkg);
  data.packages = pkgs;
  fs.writeFileSync(settings, JSON.stringify(data, null, 2) + "\n");
  console.log(`  ✓ registered pi package ${pkg}`);
}
JS

# --- 4. Retire copies the package now provides (avoid double loading). -----
# Anything in ~/.pi/agent/{extensions,skills} with the same name as a package
# resource, plus retired resources, is moved (never deleted) to a backup dir.
BACKUP="$AGENT_DIR/backups/mission-stack-$(date +%Y%m%d-%H%M%S)"
retire() {
    local path="$1"
    [[ -e "$path" || -L "$path" ]] || return 0
    mkdir -p "$BACKUP/$(basename "$(dirname "$path")")"
    mv "$path" "$BACKUP/$(basename "$(dirname "$path")")/"
    echo "  ↪ retired $path"
}
for ext in "$SCRIPT_DIR"/modules/*/extensions/*/; do
    retire "$AGENT_DIR/extensions/$(basename "$ext")"
done
for skill in "$SCRIPT_DIR"/modules/*/skills/*/; do
    retire "$AGENT_DIR/skills/$(basename "$skill")"
done
[[ -d "$BACKUP" ]] && echo "  ✓ old copies backed up to $BACKUP"

# --- 5. Domain registry (personal: seed only when missing, never overwrite).
if [[ -e "$DOMAINS_DEST" ]]; then
    echo "  ✓ domain registry preserved ($DOMAINS_DEST)"
else
    mkdir -p "$(dirname "$DOMAINS_DEST")"
    cp "$DOMAINS_SEED" "$DOMAINS_DEST"
    echo "  ✓ domain registry seeded ($DOMAINS_DEST)"
fi

# --- 6. Protocol. ---------------------------------------------------------
if [[ -e "$HOME/Missions.md" ]]; then
    if cmp -s "$MISSIONS_DIR/protocol/Missions.md" "$HOME/Missions.md"; then
        echo "  ✓ ~/Missions.md up to date"
    else
        echo "  ! ~/Missions.md differs from the bundled protocol; left untouched" >&2
    fi
else
    cp "$MISSIONS_DIR/protocol/Missions.md" "$HOME/Missions.md"
    echo "  ✓ ~/Missions.md"
fi

# --- 7. Scripts. -----------------------------------------------------------
mkdir -p "$HOME/.local/bin"
for script in memory-export memory-import; do
    chmod +x "$SCRIPT_DIR/scripts/$script"
    cp "$SCRIPT_DIR/scripts/$script" "$HOME/.local/bin/$script"
done
rm -f "$HOME/.local/bin/bd-mem-stats"
echo "  ✓ scripts/{memory-export,memory-import} → ~/.local/bin/"

# pi-sessions CLI: symlink so it always runs this checkout (shares the parser
# and cache version with the /sessions extension). Any existing symlink is
# repointed (e.g. the pre-move ~/sandbox/pi-sessions); a regular file is not ours.
PI_SESSIONS_SRC="$SCRIPT_DIR/modules/sessions/bin/pi-sessions.mjs"
PI_SESSIONS_DEST="$HOME/.local/bin/pi-sessions"
chmod +x "$PI_SESSIONS_SRC"
if [[ -L "$PI_SESSIONS_DEST" || ! -e "$PI_SESSIONS_DEST" ]]; then
    ln -sfn "$PI_SESSIONS_SRC" "$PI_SESSIONS_DEST"
    echo "  ✓ pi-sessions → ~/.local/bin/ (symlink, needs fzf >= 0.50)"
else
    echo "  ! $PI_SESSIONS_DEST is a regular file; left untouched" >&2
fi

# --- 8. Swap the validated binaries into place. ----------------------------
# mx.prev is kept after success: it is the one-step rollback for a bad mx.
mv -f "$TMP_BIN" "$BIN_DIR/memory-server"
chmod +x "$BIN_DIR/memory-server"
mv -f "$TMP_MX" "$MX_DEST"
chmod +x "$MX_DEST"
trap - EXIT ERR   # binaries are in place; disable cleanup/rollback traps
rm -f "$BIN_DIR/memory-server.prev"
echo "  ✓ memory-server binary → ~/.pi/bin/"
echo "  ✓ mx → ~/.local/bin/mx (previous kept as mx.prev)"

# --- 9. Install manifest (version + hash) for rollback/audit. --------------
GIT_REV="$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
cat > "$MANIFEST" <<EOF
{
  "installed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "git_rev": "$GIT_REV",
  "binary_sha256": "$NEW_HASH",
  "mx_sha256": "$MX_HASH"
}
EOF
echo "  ✓ manifest → $MANIFEST"

echo ""
echo "Done. Restart pi (or /reload) to load the package."

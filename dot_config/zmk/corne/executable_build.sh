#!/usr/bin/env bash
#
# Local ZMK firmware build for Keebart Corne Choc Pro BT using Docker.
#
# Usage:
#   ./build.sh              # Incremental build (fast — seconds for keymap changes)
#   ./build.sh left         # Build only left half
#   ./build.sh right        # Build only right half
#   ./build.sh pristine     # Force full rebuild from scratch
#   ./build.sh clean        # Remove build artifacts and cached west data
#   ./build.sh init         # Just fetch/update west modules (no build)
#
set -euo pipefail

DOCKER_IMAGE="zmkfirmware/zmk-build-arm:stable"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIRMWARE_DIR="${SCRIPT_DIR}/firmware"
DOCKER_WORKSPACE="/workspace"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# Check Docker is available
if ! command -v docker &>/dev/null; then
    error "Docker is not installed. Please install Docker first."
    exit 1
fi

if ! docker info &>/dev/null 2>&1; then
    error "Docker daemon is not running. Please start Docker."
    exit 1
fi

# Handle clean command
if [[ "${1:-}" == "clean" ]]; then
    info "Cleaning build artifacts and cached west data..."
    rm -rf "${FIRMWARE_DIR}" "${SCRIPT_DIR}/build" "${SCRIPT_DIR}/.west" \
           "${SCRIPT_DIR}/zmk" "${SCRIPT_DIR}/zephyr" "${SCRIPT_DIR}/modules"
    info "Done."
    exit 0
fi

# Handle pristine flag
PRISTINE=""
FILTER="all"
for arg in "$@"; do
    case "$arg" in
        pristine) PRISTINE="-p" ;;
        init)     FILTER="init" ;;
        *)        FILTER="$arg" ;;
    esac
done

# Parse build.yaml for targets
parse_targets() {
    local filter="$1"
    python3 -c "
import yaml, sys
with open('build.yaml') as f:
    data = yaml.safe_load(f)
for item in data.get('include', []):
    board = item.get('board', '')
    shield = item.get('shield', '')
    if '$filter' == 'all' or '$filter' in shield.lower() or '$filter' in board.lower():
        print(f'{board},{shield}')
" 2>/dev/null || {
        # Fallback: simple parsing if python/yaml not available
        if [[ "$filter" == "all" ]]; then
            echo "corne_choc_pro_left,nice_view_disp"
            echo "corne_choc_pro_right,nice_view_disp"
        elif [[ "$filter" == *"left"* ]]; then
            echo "corne_choc_pro_left,nice_view_disp"
        elif [[ "$filter" == *"right"* ]]; then
            echo "corne_choc_pro_right,nice_view_disp"
        fi
    }
}

# Export macOS system CA certificates (includes corporate proxy CAs like Zscaler)
CERT_BUNDLE="/tmp/zmk-build-ca-certs.pem"
DOCKER_SSL_OPTS=()
if [[ "$(uname)" == "Darwin" ]]; then
    security find-certificate -a -p /Library/Keychains/System.keychain > "${CERT_BUNDLE}" 2>/dev/null
    security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain >> "${CERT_BUNDLE}" 2>/dev/null
    if [[ -s "${CERT_BUNDLE}" ]]; then
        DOCKER_SSL_OPTS+=(-v "${CERT_BUNDLE}:/etc/ssl/certs/ca-certificates.crt:ro")
    fi
elif [[ -f /etc/ssl/certs/ca-certificates.crt ]]; then
    DOCKER_SSL_OPTS+=(-v "/etc/ssl/certs/ca-certificates.crt:/etc/ssl/certs/ca-certificates.crt:ro")
fi

# Run west init + update only when needed (first run or west.yml changed)
ensure_west_modules() {
    local need_update=false

    if [[ ! -d "${SCRIPT_DIR}/.west" ]]; then
        need_update=true
    elif [[ ! -d "${SCRIPT_DIR}/zmk" ]]; then
        need_update=true
    elif [[ "${SCRIPT_DIR}/config/west.yml" -nt "${SCRIPT_DIR}/.west/config" ]]; then
        # west.yml changed since last init
        need_update=true
    fi

    if [[ "$need_update" == true ]]; then
        info "Fetching ZMK + Zephyr modules (first run or west.yml changed)..."
        docker run --rm \
            -v "${SCRIPT_DIR}:/workspace" \
            "${DOCKER_SSL_OPTS[@]}" \
            -w "${DOCKER_WORKSPACE}" \
            "${DOCKER_IMAGE}" \
            bash -c "
                set -e
                if [ ! -d .west ]; then
                    west init -l config
                fi
                west update --fetch-opt=--filter=blob:none
                west zephyr-export
            "
        info "Modules ready."
    else
        info "West modules up to date (skipping fetch)."
    fi
}

ensure_west_modules

# Handle init-only command
if [[ "$FILTER" == "init" ]]; then
    info "Init complete."
    exit 0
fi

TARGETS=$(parse_targets "$FILTER")
if [[ -z "$TARGETS" ]]; then
    error "No matching targets found for filter: ${FILTER}"
    echo "Available targets:"
    parse_targets "all" | while IFS=, read -r board shield; do
        echo "  - ${board}${shield:+ ($shield)}"
    done
    exit 1
fi

mkdir -p "${FIRMWARE_DIR}"

# Build each target
echo "$TARGETS" | while IFS=, read -r board shield; do
    ARTIFACT_NAME="${board}"

    info "Building ${board}${shield:+ with shield ${shield}}..."

    # Build cmake args
    CMAKE_ARGS="-DZMK_CONFIG='${DOCKER_WORKSPACE}/config' -DBOARD_ROOT='${DOCKER_WORKSPACE}' -DSHIELD_ROOT='${DOCKER_WORKSPACE}'"
    if [[ -n "$shield" ]]; then
        CMAKE_ARGS="${CMAKE_ARGS} -DSHIELD='${shield}'"
    fi

    docker run --rm \
        -v "${SCRIPT_DIR}:/workspace" \
        "${DOCKER_SSL_OPTS[@]}" \
        -w "${DOCKER_WORKSPACE}" \
        "${DOCKER_IMAGE}" \
        bash -c "
            set -e
            west zephyr-export 2>/dev/null
            echo '>>> Building firmware for ${board}...'
            west build -s zmk/app -b '${board}' -d 'build/${ARTIFACT_NAME}' ${PRISTINE} -- \
                ${CMAKE_ARGS}

            if [ -f 'build/${ARTIFACT_NAME}/zephyr/zmk.uf2' ]; then
                cp 'build/${ARTIFACT_NAME}/zephyr/zmk.uf2' 'firmware/${ARTIFACT_NAME}-zmk.uf2'
                echo '>>> Output: firmware/${ARTIFACT_NAME}-zmk.uf2'
            fi
        "

    if [[ -f "${FIRMWARE_DIR}/${ARTIFACT_NAME}-zmk.uf2" ]]; then
        info "Built: firmware/${ARTIFACT_NAME}-zmk.uf2"
    else
        error "Build failed for ${board}"
        exit 1
    fi
done

info "All builds complete! Firmware files:"
ls -la "${FIRMWARE_DIR}"/*.uf2 2>/dev/null || warn "No .uf2 files found"

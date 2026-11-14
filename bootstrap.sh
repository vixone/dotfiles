#!/usr/bin/env bash
# Install only reusable software. No missions, memories or credentials are imported.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd -P)"
check=0
rig=0
for arg in "$@"; do
  case "$arg" in
    --check) check=1 ;;
    --with-rig) rig=1 ;;
    -h|--help) echo 'Usage: ./bootstrap.sh [--check] [--with-rig]'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done
for tool in node npm go cargo git cc; do
  command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 1; }
done
node -e 'if(Number(process.versions.node.split(".")[0]) < 26) { console.error("Use Node 26 or newer for the Pi core"); process.exit(1); }'
if [[ "$rig" = 1 && "$(uname -s)" != Darwin ]]; then
  echo 'OpenRig requires macOS sandbox-exec. No Linux fallback is provided.' >&2
  exit 1
fi
if [[ "$check" = 1 ]]; then
  echo 'Core build prerequisites found. Provider login and runtime extension loading are not checked.'
  exit 0
fi
if ! command -v pi >/dev/null; then
  npm install -g @earendil-works/pi-coding-agent@1.5.2
fi
bash "$root/packages/mission-stack/install.sh"
if [[ "$rig" = 1 ]]; then
  for part in node openrig; do
    npm ci --prefix "$root/packages/openrig/.runtime/$part"
  done
  npm ci --prefix "$root/packages/openrig"
  echo 'Rig dependencies installed. No rig provisioned, linked or started. See packages/openrig/README.md.'
fi
printf '\nKeep this checkout: Pi loads mission-stack from it. Restart Pi or run /reload.\n'
printf 'Configure your own Pi provider and model with /login and /model. No credentials were copied.\n'

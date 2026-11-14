#!/bin/sh
set -eu
# Resolve symlinked entry points before deriving the local package identity.
entry=$0
while [ -L "$entry" ]; do
  parent=$(CDPATH= cd -- "$(dirname -- "$entry")" && pwd -P)
  target=$(readlink "$entry")
  case "$target" in /*) entry=$target ;; *) entry=$parent/$target ;; esac
done
root=$(CDPATH= cd -- "$(dirname -- "$entry")" && pwd -P)
usage() { echo 'Usage: ./install.sh --check | --install | --remove | --archive /absolute/pi-sdd.tar.gz' >&2; exit 2; }
[ "$#" -ge 1 ] || usage
case "$1" in
  --check) [ "$#" -eq 1 ] || usage; exec node "$root/scripts/archive.ts" --check ;;
  --install) [ "$#" -eq 1 ] || usage; exec pi install "$root" ;;
  --remove) [ "$#" -eq 1 ] || usage; exec pi remove "$root" ;;
  --archive) [ "$#" -eq 2 ] || usage; exec node "$root/scripts/archive.ts" --archive "$2" ;;
  *) usage ;;
esac

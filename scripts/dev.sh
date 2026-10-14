#!/bin/bash
#
# Runs myFile straight from the source folder (no app bundle), for development.
# Run "bash install.sh --no-open" once first so Node and Electron are present.
#
#   bash scripts/dev.sh            start the app with DevTools available
#   bash scripts/dev.sh --test     run the backend test suite

set -euo pipefail

# shellcheck source=env.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"

command -v node >/dev/null 2>&1 || die "Node.js is not set up yet. Run: bash install.sh --no-open"
cd "$MYFILE_ROOT"

if [ "${1:-}" = "--test" ]; then
  exec node --test test/*.test.js
fi

[ -d node_modules/electron ] || die "Electron is not installed yet. Run: bash install.sh --no-open"
export MYFILE_DEV=1
exec node node_modules/electron/cli.js . ${1+"$@"}

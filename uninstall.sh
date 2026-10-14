#!/bin/bash
#
# Removes myFile from this Mac completely.
#
# Deleting the folder already removes everything myFile downloaded or saved.
# This script also clears the little bits macOS keeps about every app you
# open (window-restore state, privacy permissions, Launch Services entry),
# then deletes the folder itself.
#
# Usage:
#   bash uninstall.sh                remove macOS traces, then delete this folder
#   bash uninstall.sh --keep-source  remove traces, the app and downloads, but keep
#                                    the source so you can run install.sh again
#   bash uninstall.sh --yes          don't ask for confirmation

set -euo pipefail

# shellcheck source=scripts/env.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/env.sh"

KEEP_SOURCE=0
ASSUME_YES=0
for arg in ${1+"$@"}; do
  case "$arg" in
    --keep-source) KEEP_SOURCE=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $arg (try --help)" ;;
  esac
done

# Refuse to delete anything that isn't clearly a myFile folder.
[ -f "$MYFILE_ROOT/.myfile-root" ] || die "$MYFILE_ROOT does not look like a myFile folder."
case "$MYFILE_ROOT" in
  /|"$HOME"|"$HOME/") die "Refusing to delete $MYFILE_ROOT." ;;
esac

printf '%smyFile uninstaller%s\n' "$C_BOLD" "$C_RESET"
if [ "$KEEP_SOURCE" = "1" ]; then
  note "Will remove myFile.app, node_modules/, .runtime/ and macOS's records of the app."
  note "The source code in $MYFILE_ROOT stays."
else
  note "Will remove macOS's records of the app, then delete this whole folder:"
  note "$MYFILE_ROOT"
fi

if [ "$ASSUME_YES" != "1" ]; then
  printf '\nContinue? [y/N] '
  read -r answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo "Nothing was removed."; exit 0 ;;
  esac
fi

if [ "$(uname -s)" = "Darwin" ]; then
  step "Quitting myFile"
  if osascript -e "application id \"$MYFILE_BUNDLE_ID\" is running" 2>/dev/null | grep -q true; then
    osascript -e "tell application id \"$MYFILE_BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
    sleep 3
    ok "quit"
  else
    ok "not running"
  fi

  step "Clearing macOS's records of myFile"
  sweep_macos_traces
  # Privacy permissions (Desktop, Documents, removable volumes ...).
  tccutil reset All "$MYFILE_BUNDLE_ID" >/dev/null 2>&1 || true
  ok "privacy permissions reset"
  LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
  if [ -x "$LSREGISTER" ] && [ -d "$MYFILE_APP" ]; then
    "$LSREGISTER" -u "$MYFILE_APP" >/dev/null 2>&1 || true
    ok "unregistered from Launch Services"
  fi
fi

if [ "$KEEP_SOURCE" = "1" ]; then
  step "Removing the app and everything it downloaded"
  rm -rf "$MYFILE_APP" "$MYFILE_ROOT/node_modules" "$MYFILE_RUNTIME"
  ok "folder is back to a fresh download; run 'bash install.sh' to build again"
else
  step "Deleting $MYFILE_ROOT"
  cd /
  rm -rf "$MYFILE_ROOT"
  ok "myFile is gone"
fi

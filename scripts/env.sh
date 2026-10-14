# shellcheck shell=bash
#
# Shared environment for install.sh, uninstall.sh and dev.sh.
#
# myFile's rule: everything it downloads or generates lives inside this folder.
# Node, npm's cache, Electron's download cache, temporary files and the app's
# own data all go under .runtime/, so deleting the folder deletes all of it.
# The variables below point every tool we run at that folder instead of the
# usual places in your home directory (~/.npm, ~/Library/Caches/electron, ...).

MYFILE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MYFILE_RUNTIME="$MYFILE_ROOT/.runtime"
MYFILE_APP="$MYFILE_ROOT/myFile.app"
MYFILE_BUNDLE_ID="io.github.zhengzihao2002.myfile"

# Pinned toolchain. Checksums come from https://nodejs.org/dist/v24.21.0/SHASUMS256.txt
NODE_VERSION="24.21.0"
NODE_SHA256_ARM64="6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe"
NODE_SHA256_X64="0ae5a24c24bb7d015cd816c5036b3f90f2945aa872fcf54e58da054753b3a299"

# Only used if this Mac has no /usr/bin/perl (ExifTool is written in Perl).
PERL_FALLBACK_VERSION="5.44.0.0"

export PATH="$MYFILE_RUNTIME/node/bin:$PATH"

# npm: cache, logs and the update check stay in .runtime/cache/npm.
export npm_config_cache="$MYFILE_RUNTIME/cache/npm"
export npm_config_prefix="$MYFILE_RUNTIME/node"
export npm_config_update_notifier=false
export npm_config_fund=false
export npm_config_audit=false

# Electron's installer downloads its runtime zip into this cache.
export electron_config_cache="$MYFILE_RUNTIME/cache/electron"

# Temporary files (Electron's downloader unpacks through os.tmpdir()).
export TMPDIR="$MYFILE_RUNTIME/tmp/"

# Node never writes a REPL history file; corepack and XDG-aware tools stay local.
export NODE_REPL_HISTORY=""
export COREPACK_HOME="$MYFILE_RUNTIME/cache/corepack"
export XDG_CACHE_HOME="$MYFILE_RUNTIME/cache/xdg"
export XDG_CONFIG_HOME="$MYFILE_RUNTIME/config"
export XDG_DATA_HOME="$MYFILE_RUNTIME/data"

mkdir -p "$MYFILE_RUNTIME/tmp" "$MYFILE_RUNTIME/cache"

# ---------------------------------------------------------------------------
# Small helpers shared by the scripts
# ---------------------------------------------------------------------------

if [ -t 1 ]; then
  C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'
  C_BLUE=$'\033[34m'; C_YELLOW=$'\033[33m'; C_RESET=$'\033[0m'
else
  C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_BLUE=""; C_YELLOW=""; C_RESET=""
fi

step() { printf '\n%s==>%s %s%s%s\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
ok()   { printf '    %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
note() { printf '    %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
warn() { printf '    %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
die()  { printf '\n%sError:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

# Removes macOS's own bookkeeping for the app: window-restore state, the
# preferences file the open/save panels write, and per-app caches. The app
# runs the same sweep each time it quits; uninstall.sh runs it once more.
sweep_macos_traces() {
  local lib="$HOME/Library"
  defaults delete "$MYFILE_BUNDLE_ID" >/dev/null 2>&1 || true
  local p
  for p in \
    "$lib/Saved Application State/$MYFILE_BUNDLE_ID.savedState" \
    "$lib/Preferences/$MYFILE_BUNDLE_ID.plist" \
    "$lib/Caches/$MYFILE_BUNDLE_ID" \
    "$lib/HTTPStorages/$MYFILE_BUNDLE_ID" \
    "$lib/HTTPStorages/$MYFILE_BUNDLE_ID.binarycookies" \
    "$lib/WebKit/$MYFILE_BUNDLE_ID"; do
    if [ -e "$p" ]; then rm -rf "$p" && note "removed $p"; fi
  done
  # Helper processes have their own bundle ids (…myfile.helper, …helper.renderer).
  for p in "$lib/Preferences/$MYFILE_BUNDLE_ID".helper*.plist \
           "$lib/Caches/$MYFILE_BUNDLE_ID".helper* \
           "$lib/HTTPStorages/$MYFILE_BUNDLE_ID".helper*; do
    if [ -e "$p" ]; then rm -rf "$p" && note "removed $p"; fi
  done
}

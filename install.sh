#!/bin/bash
#
# myFile installer
#
# Builds myFile.app on this Mac from the source in this folder. Everything it
# downloads (Node.js, Electron, ExifTool) is kept inside this folder, in
# .runtime/ and node_modules/. Nothing is installed system-wide and no admin
# password is needed. Delete the folder and it is all gone.
#
# Usage:
#   bash install.sh             set up, build myFile.app, then open it
#   bash install.sh --no-open   same, but don't open the app at the end
#   bash install.sh --rebuild   only rebuild myFile.app from the current source
#   bash install.sh --help

set -euo pipefail

# shellcheck source=scripts/env.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/env.sh"

OPEN_AT_END=1
REBUILD_ONLY=0
for arg in ${1+"$@"}; do
  case "$arg" in
    --no-open) OPEN_AT_END=0 ;;
    --rebuild) REBUILD_ONLY=1 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $arg (try --help)" ;;
  esac
done

printf '%smyFile installer%s\n' "$C_BOLD" "$C_RESET"
note "Folder: $MYFILE_ROOT"

# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

[ "$(uname -s)" = "Darwin" ] || die "myFile is a macOS app. This looks like $(uname -s)."
[ "$(id -u)" -ne 0 ] || die "Please run this without sudo. myFile installs into its own folder and never needs admin rights."

MACOS_VERSION="$(sw_vers -productVersion)"
MACOS_MAJOR="${MACOS_VERSION%%.*}"
if [ "$MACOS_MAJOR" -lt 12 ]; then
  die "myFile needs macOS 12 (Monterey) or newer. This Mac has macOS $MACOS_VERSION."
fi

ARCH="$(uname -m)"
# A Terminal running under Rosetta reports x86_64 on Apple silicon; use the native build.
if [ "$ARCH" = "x86_64" ] && [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
  ARCH="arm64"
fi
case "$ARCH" in
  arm64)  NODE_ARCH="arm64"; NODE_SHA256="$NODE_SHA256_ARM64"; PERL_ARCH="arm64" ;;
  x86_64) NODE_ARCH="x64";   NODE_SHA256="$NODE_SHA256_X64";   PERL_ARCH="amd64" ;;
  *) die "Unsupported processor: $ARCH" ;;
esac
note "macOS $MACOS_VERSION on $ARCH"

case "$MYFILE_ROOT" in
  *$'\n'*) die "The folder path contains a line break. Move the folder somewhere simpler and try again." ;;
esac

DOWNLOADS="$MYFILE_RUNTIME/downloads"
mkdir -p "$DOWNLOADS"

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    openssl dgst -sha256 -r "$1" | awk '{print $1}'
  fi
}

fetch() { # fetch URL DEST
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 --progress-bar -o "$2.part" "$1" \
    || die "Download failed: $1
       Check your internet connection and run the installer again."
  mv "$2.part" "$2"
}

# ---------------------------------------------------------------------------
# 1. Node.js (only used to install and build; the app itself runs on Electron)
# ---------------------------------------------------------------------------

install_node() {
  step "Node.js $NODE_VERSION"
  local node_dir="$MYFILE_RUNTIME/node"
  if [ -x "$node_dir/bin/node" ] && [ "$("$node_dir/bin/node" -v 2>/dev/null)" = "v$NODE_VERSION" ]; then
    ok "already in .runtime/node"
    return
  fi
  local tarball="node-v$NODE_VERSION-darwin-$NODE_ARCH.tar.xz"
  local file="$DOWNLOADS/$tarball"
  if [ ! -f "$file" ] || [ "$(sha256_of "$file")" != "$NODE_SHA256" ]; then
    note "downloading $tarball"
    fetch "https://nodejs.org/dist/v$NODE_VERSION/$tarball" "$file"
  fi
  local actual
  actual="$(sha256_of "$file")"
  if [ "$actual" != "$NODE_SHA256" ]; then
    rm -f "$file"
    die "Checksum mismatch for $tarball.
       expected $NODE_SHA256
       got      $actual"
  fi
  ok "checksum verified"
  rm -rf "$node_dir"
  mkdir -p "$node_dir"
  tar -xJf "$file" -C "$node_dir" --strip-components 1
  ok "unpacked into .runtime/node"
}

# ---------------------------------------------------------------------------
# 2. Perl, which ExifTool runs on. macOS includes it; fall back to a private copy.
# ---------------------------------------------------------------------------

check_perl() {
  step "Perl (for ExifTool)"
  if /usr/bin/perl -e 'use 5.010; exit 0' >/dev/null 2>&1; then
    ok "using macOS's built-in perl ($(/usr/bin/perl -e 'printf "%vd", $^V'))"
    rm -rf "$MYFILE_RUNTIME/perl"
    return
  fi
  local perl_dir="$MYFILE_RUNTIME/perl"
  if [ -x "$perl_dir/bin/perl" ]; then
    ok "using private perl in .runtime/perl"
    return
  fi
  warn "This Mac has no built-in perl. Downloading a private copy into .runtime/perl"
  local tarball="perl-darwin-$PERL_ARCH.tar.gz"
  fetch "https://github.com/skaji/relocatable-perl/releases/download/$PERL_FALLBACK_VERSION/$tarball" "$DOWNLOADS/$tarball"
  mkdir -p "$perl_dir"
  tar -xzf "$DOWNLOADS/$tarball" -C "$perl_dir" --strip-components 1
  "$perl_dir/bin/perl" -e 'exit 0' || die "The downloaded perl does not run on this Mac."
  ok "private perl ready"
}

# ---------------------------------------------------------------------------
# 3. npm packages: Electron and ExifTool, exactly as pinned in package-lock.json
# ---------------------------------------------------------------------------

install_packages() {
  step "Electron and ExifTool (npm packages)"
  local stamp="$MYFILE_ROOT/node_modules/.myfile-installed"
  local want
  want="$(sha256_of "$MYFILE_ROOT/package-lock.json")-$NODE_ARCH"
  if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$want" ] \
     && [ -d "$MYFILE_ROOT/node_modules/electron/dist/Electron.app" ]; then
    ok "already installed in node_modules"
    return
  fi
  note "this downloads about 120 MB the first time"
  (cd "$MYFILE_ROOT" && npm ci --no-audit --no-fund --loglevel=error) \
    || die "npm could not install the packages. See the messages above."
  [ -d "$MYFILE_ROOT/node_modules/electron/dist/Electron.app" ] \
    || die "Electron did not finish downloading. Run the installer again."
  echo "$want" > "$stamp"
  ok "installed into node_modules"
}

# ---------------------------------------------------------------------------
# 4. Build myFile.app
# ---------------------------------------------------------------------------

build_app() {
  step "Building myFile.app"
  if osascript -e "application id \"$MYFILE_BUNDLE_ID\" is running" 2>/dev/null | grep -q true; then
    note "myFile is running; quitting it so it can be rebuilt"
    osascript -e "tell application id \"$MYFILE_BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
    sleep 2
  fi
  node "$MYFILE_ROOT/scripts/build-app.mjs" || die "Building the app failed. See the messages above."
}

cleanup() {
  # Downloads and caches are only needed during installation.
  rm -rf "$DOWNLOADS" "$MYFILE_RUNTIME/cache" "$MYFILE_RUNTIME/tmp"
}

if [ "$REBUILD_ONLY" = "1" ]; then
  [ -x "$MYFILE_RUNTIME/node/bin/node" ] || die "Run 'bash install.sh' once before using --rebuild."
  build_app
else
  install_node
  check_perl
  install_packages
  build_app
  step "Tidying up"
  cleanup
  ok "removed downloads and caches"
fi

USED="$(du -sh "$MYFILE_ROOT" 2>/dev/null | awk '{print $1}')"
printf '\n%s%sDone.%s myFile.app is ready in this folder.\n' "$C_BOLD" "$C_GREEN" "$C_RESET"
note "Everything myFile uses ($USED) is inside: $MYFILE_ROOT"
note "To remove myFile completely, run: bash uninstall.sh"

if [ "$OPEN_AT_END" = "1" ]; then
  open "$MYFILE_APP"
fi

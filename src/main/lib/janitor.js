"use strict";

// macOS records a few things about every app it runs, outside the app's own
// folder: window-restore state, a preferences file written by the open/save
// panels, and per-app caches. myFile removes them every time it quits, so
// deleting the project folder really leaves nothing behind.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

// Only a full reverse-DNS id (like io.github.someone.app) is ever used to
// build paths; anything else would point at shared folders like ~/Library/Caches.
function isSafeBundleId(id) {
  return typeof id === "string" && /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){2,}$/.test(id);
}

function tracePaths(bundleId) {
  if (!isSafeBundleId(bundleId)) return [];
  const lib = path.join(os.homedir(), "Library");
  const fixed = [
    path.join(lib, "Saved Application State", `${bundleId}.savedState`),
    path.join(lib, "Preferences", `${bundleId}.plist`),
    path.join(lib, "Caches", bundleId),
    path.join(lib, "HTTPStorages", bundleId),
    path.join(lib, "HTTPStorages", `${bundleId}.binarycookies`),
    path.join(lib, "WebKit", bundleId),
  ];
  // Helper processes use ids like "<bundleId>.helper.renderer".
  for (const dir of ["Preferences", "Caches", "HTTPStorages"]) {
    try {
      for (const name of fs.readdirSync(path.join(lib, dir))) {
        if (name.startsWith(`${bundleId}.helper`)) fixed.push(path.join(lib, dir, name));
      }
    } catch {
      // folder missing or unreadable
    }
  }
  return fixed;
}

/** Removes leftovers from an earlier run that didn't quit normally. */
function sweepNow(bundleId) {
  if (process.platform !== "darwin") return;
  for (const p of tracePaths(bundleId)) {
    if (p.endsWith(".plist")) continue; // owned by cfprefsd while we run
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Starts a tiny detached shell that waits for this process to exit, then
 * removes the traces (and any extra paths, such as a temporary data folder).
 */
function sweepAfterExit(bundleId, extraPaths = []) {
  const paths = process.platform === "darwin" ? tracePaths(bundleId) : [];
  paths.push(...extraPaths.filter(Boolean));
  if (!paths.length) return;
  const script = [
    'pid="$1"; id="$2"; shift 2',
    'i=0; while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 300 ]; do sleep 0.2; i=$((i+1)); done',
    "sleep 0.5",
    isSafeBundleId(bundleId) ? '[ -x /usr/bin/defaults ] && /usr/bin/defaults delete "$id" >/dev/null 2>&1' : ":",
    'for p in "$@"; do rm -rf "$p"; done',
  ].join("\n");
  try {
    const child = spawn("/bin/sh", ["-c", script, "myfile-janitor", String(process.pid), bundleId, ...paths], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // Nothing else we can do; uninstall.sh sweeps the same paths.
  }
}

module.exports = { tracePaths, sweepNow, sweepAfterExit, isSafeBundleId };

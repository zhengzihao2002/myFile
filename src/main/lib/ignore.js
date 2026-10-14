"use strict";

// Operating-system bookkeeping files. They are rewritten constantly by the OS
// and are not part of what makes two folders "the same", so every feature
// skips them unless "Include system files" is turned on.
const DEFAULT_IGNORES = [
  // macOS
  ".DS_Store", "._*", ".AppleDouble", ".AppleDB", ".AppleDesktop", ".LSOverride",
  ".Spotlight-V100", ".DocumentRevisions-V100", ".TemporaryItems", ".Trashes",
  ".fseventsd", ".VolumeIcon.icns", ".apdisk", ".com.apple.timemachine.donotpresent",
  "Icon\r", ".localized",
  // Windows
  "Thumbs.db", "Thumbs.db:encryptable", "ehthumbs.db", "ehthumbs_vista.db",
  "desktop.ini", "$RECYCLE.BIN", "System Volume Information",
  // Linux
  ".directory", ".Trash-*",
  // myFile's own in-progress copies
  ".myfile-partial-*",
];

function globToRegExp(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") source += ".*";
    else if (ch === "?") source += ".";
    else if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close < 0) {
        source += "\\[";
      } else {
        let body = pattern.slice(i + 1, close);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        source += `[${body.replace(/\\/g, "\\\\")}]`;
        i = close;
      }
    } else source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "is");
}

// Builds a case-insensitive name matcher from fnmatch-style patterns.
function makeIgnore(patterns = DEFAULT_IGNORES) {
  const exact = new Set();
  const globs = [];
  for (const raw of patterns) {
    const p = String(raw);
    if (!p) continue;
    if (/[*?[]/.test(p)) globs.push(globToRegExp(p));
    else exact.add(p.toLowerCase());
  }
  return (name) => exact.has(name.toLowerCase()) || globs.some((re) => re.test(name));
}

const NEVER = () => false;

function ignoreFor(options = {}) {
  if (options.includeAll) return NEVER;
  const extra = Array.isArray(options.ignore) ? options.ignore : [];
  return makeIgnore(DEFAULT_IGNORES.concat(extra));
}

module.exports = { DEFAULT_IGNORES, makeIgnore, ignoreFor };

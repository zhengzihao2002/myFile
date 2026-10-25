"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { extOf, checkCancel, errText } = require("./util");

const IMAGE_EXT = new Set([
  "jpg", "jpeg", "jpe", "png", "heic", "heif", "hif", "avif", "tif", "tiff", "gif", "webp", "bmp",
  "dng", "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "raf", "orf", "rw2", "pef", "srw",
  "3fr", "iiq", "x3f", "erf", "mos", "mrw", "kdc", "dcr", "psd", "jxl", "jp2",
]);
const VIDEO_EXT = new Set([
  "mov", "mp4", "m4v", "3gp", "3g2", "qt", "avi", "mkv", "mts", "m2ts", "wmv", "webm", "mpg", "mpeg", "insv", "lrv",
]);
// QuickTime/MP4 containers, whose dates live in QuickTime atoms (UTC) and Keys.
const QUICKTIME_EXT = new Set(["mov", "mp4", "m4v", "3gp", "3g2", "qt", "insv", "lrv"]);
// Shown directly by Chromium; everything else is converted for the preview.
const BROWSER_IMAGE = new Set(["jpg", "jpeg", "jpe", "png", "gif", "webp", "avif", "bmp", "svg", "ico"]);
const BROWSER_VIDEO = new Set(["mp4", "m4v", "mov", "webm", "ogv"]);

function mediaKind(name) {
  const ext = extOf(name);
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  return null;
}

function isQuickTime(name) {
  return QUICKTIME_EXT.has(extOf(name));
}

function isMedia(name) {
  return mediaKind(name) !== null;
}

const MIME = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml", heic: "image/heic", heif: "image/heif",
  tif: "image/tiff", tiff: "image/tiff", mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime",
  webm: "video/webm", dng: "image/x-adobe-dng", cr2: "image/x-canon-cr2", nef: "image/x-nikon-nef",
  arw: "image/x-sony-arw", pdf: "application/pdf", txt: "text/plain", html: "text/html",
};

function mimeOf(name) {
  return MIME[extOf(name)] || "application/octet-stream";
}

/**
 * Turns a mix of files and folders into a flat list of media files. Folders
 * are searched recursively (system files skipped); files that aren't media
 * are reported in `skipped` when they were given explicitly.
 */
async function expandMediaPaths(paths, { ignore = () => false, recursive = true, signal, onProgress } = {}) {
  const files = [];
  const skipped = [];
  const seen = new Set();
  const add = (p) => {
    const key = p.normalize("NFC");
    if (seen.has(key)) return;
    seen.add(key);
    files.push(p);
    if (onProgress && files.length % 200 === 0) onProgress({ found: files.length, current: require("node:path").basename(p) });
  };

  const walk = async (dir) => {
    checkCancel(signal);
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      skipped.push({ path: dir, reason: errText(err) });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (ignore(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) await walk(full);
      } else if (entry.isFile() && isMedia(entry.name)) {
        add(full);
      }
    }
  };

  for (const p of paths) {
    let st;
    try {
      st = await fs.promises.stat(p);
    } catch (err) {
      skipped.push({ path: p, reason: errText(err) });
      continue;
    }
    if (st.isDirectory()) await walk(p);
    else if (st.isFile()) {
      if (isMedia(p)) add(p);
      else skipped.push({ path: p, reason: "Not a photo or video" });
    }
  }
  return { files, skipped };
}

module.exports = {
  IMAGE_EXT,
  VIDEO_EXT,
  BROWSER_IMAGE,
  BROWSER_VIDEO,
  mediaKind,
  isQuickTime,
  isMedia,
  mimeOf,
  expandMediaPaths,
};

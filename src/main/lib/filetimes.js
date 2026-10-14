"use strict";

// Reading and writing file dates.
//
// Modification and access dates are set with utimes (lutimes for symlinks).
// Creation dates are trickier: no portable API exists, and ExifTool needs
// Apple's developer tools ("setfile") for it. On macOS we batch them through
// NSFileManager via osascript instead, which every Mac has.
//
// Order matters on macOS: setting a modification date earlier than the
// creation date also pulls the creation date back, so modification dates are
// always written first and creation dates second.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { checkCancel, errText, newId } = require("./util");

const IS_MAC = process.platform === "darwin";
const JXA_SCRIPT = path.join(__dirname, "jxa-set-creation.js");
const BATCH = 1500;

const config = { tmpDir: os.tmpdir() };

function configure(options) {
  Object.assign(config, options);
}

function canSetBirthtime() {
  return IS_MAC;
}

async function readTimes(p) {
  const st = await fs.promises.lstat(p);
  return { birthMs: st.birthtimeMs, mtimeMs: st.mtimeMs, atimeMs: st.atimeMs, isLink: st.isSymbolicLink() };
}

function runOsascript(jobFile, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", JXA_SCRIPT, jobFile],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim()));
        else resolve(stdout);
      },
    );
  });
}

async function setBirthtimesMac(items, signal) {
  const errors = new Array(items.length).fill("");
  for (let start = 0; start < items.length; start += BATCH) {
    checkCancel(signal);
    const chunk = items.slice(start, start + BATCH);
    const jobFile = path.join(config.tmpDir, `myfile-ctime-${newId()}.json`);
    await fs.promises.mkdir(config.tmpDir, { recursive: true });
    await fs.promises.writeFile(jobFile, JSON.stringify(chunk.map((it) => ({ p: it.path, s: it.birthMs / 1000 }))));
    try {
      const out = await runOsascript(jobFile, 30000 + chunk.length * 50);
      const list = JSON.parse(out.trim());
      list.forEach((msg, i) => {
        errors[start + i] = msg || "";
      });
    } catch (err) {
      // osascript itself failed. Fall back to the utimes trick, which can
      // move a creation date earlier (never later).
      for (let i = 0; i < chunk.length; i++) {
        errors[start + i] = await pullBirthEarlier(chunk[i], err);
      }
    } finally {
      fs.promises.rm(jobFile, { force: true }).catch(() => {});
    }
  }
  return errors;
}

async function pullBirthEarlier(item, cause) {
  try {
    const st = await fs.promises.lstat(item.path);
    if (item.birthMs >= st.birthtimeMs) return `Could not set the creation date (${cause.message})`;
    await fs.promises.utimes(item.path, st.atimeMs / 1000, item.birthMs / 1000);
    await fs.promises.utimes(item.path, st.atimeMs / 1000, st.mtimeMs / 1000);
    return "";
  } catch (err) {
    return errText(err);
  }
}

/**
 * Applies dates to many items. Each entry is { path, mtimeMs?, atimeMs?,
 * birthMs?, isLink? }; any date left out stays as it is.
 * Returns { changed, failures: [{ path, error }], birthUnsupported }.
 */
async function applyTimes(entries, { signal, onProgress } = {}) {
  const failures = [];
  const failed = new Set();
  let done = 0;
  const total = entries.length;

  for (const entry of entries) {
    checkCancel(signal);
    if (entry.mtimeMs === undefined && entry.atimeMs === undefined) continue;
    try {
      let { mtimeMs, atimeMs } = entry;
      if (mtimeMs === undefined || atimeMs === undefined) {
        const st = await fs.promises.lstat(entry.path);
        if (mtimeMs === undefined) mtimeMs = st.mtimeMs;
        if (atimeMs === undefined) atimeMs = st.atimeMs;
      }
      const setter = entry.isLink ? fs.promises.lutimes : fs.promises.utimes;
      await setter(entry.path, atimeMs / 1000, mtimeMs / 1000);
    } catch (err) {
      failures.push({ path: entry.path, error: `modification date: ${errText(err)}` });
      failed.add(entry.path);
    }
    done++;
    if (onProgress && done % 200 === 0) onProgress({ done, total, phase: "modified" });
  }

  const births = entries.filter((e) => e.birthMs !== undefined && e.birthMs !== null && !e.isLink && !failed.has(e.path));
  let birthUnsupported = 0;
  if (births.length) {
    if (!canSetBirthtime()) {
      birthUnsupported = births.length;
    } else {
      if (onProgress) onProgress({ done: 0, total: births.length, phase: "created" });
      const errors = await setBirthtimesMac(births, signal);
      errors.forEach((msg, i) => {
        if (msg) failures.push({ path: births[i].path, error: `creation date: ${msg}` });
      });
    }
  }
  if (onProgress) onProgress({ done: total, total, phase: "done" });
  return { changed: total - failed.size, failures, birthUnsupported };
}

module.exports = { configure, canSetBirthtime, readTimes, applyTimes };

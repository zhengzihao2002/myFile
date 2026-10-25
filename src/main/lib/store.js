"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { newId } = require("./util");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// Write to a temp file and rename, so a crash never leaves half a file.
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}

const DEFAULT_SETTINGS = {
  theme: "system", // system | light | dark
  toleranceMs: 1000, // dates closer than this count as equal (no screen for it; drives' own time steps are added automatically)
  parallelFiles: "auto", // files read or copied at the same time: auto | 1 .. 16
  confirmBeforeApply: true,
  // What "Custom" in Folder Compare checks before calling two files identical.
  customCompare: { size: true, modified: true, created: false, exifDates: true, gps: true, otherMeta: false, contents: false },
};

class Settings {
  constructor(dataDir) {
    this.file = path.join(dataDir, "settings.json");
    this.values = { ...DEFAULT_SETTINGS, ...readJson(this.file, {}) };
  }

  get() {
    return { ...this.values };
  }

  set(patch) {
    for (const [key, value] of Object.entries(patch || {})) {
      if (key in DEFAULT_SETTINGS) this.values[key] = value;
    }
    writeJson(this.file, this.values);
    return this.get();
  }
}

/**
 * Operation history. Each entry has a small summary in history.json and, if
 * it can be undone, the old values in history/<id>.json:
 *   { times: [{ path, birthMs, mtimeMs, atimeMs, isLink }],
 *     exif:  [{ path, tags: [[tag, oldValue|null], ...] }] }
 */
class History {
  constructor(dataDir) {
    this.dir = path.join(dataDir, "history");
    this.file = path.join(dataDir, "history.json");
    this.entries = readJson(this.file, []);
  }

  list() {
    return this.entries.slice();
  }

  add({ type, title, summary, details, undo }) {
    const id = newId("op");
    const hasUndo = Boolean(undo && ((undo.times && undo.times.length) || (undo.exif && undo.exif.length)));
    const entry = {
      id,
      type,
      title,
      summary: summary || "",
      details: details || null,
      at: Date.now(),
      undoable: hasUndo,
      reverted: false,
    };
    if (hasUndo) writeJson(path.join(this.dir, `${id}.json`), undo);
    this.entries.unshift(entry);
    // Keep the newest 200 entries and their undo data.
    for (const old of this.entries.splice(200)) this._dropUndo(old.id);
    this._save();
    return entry;
  }

  /**
   * Adds more undo data to an entry (Batch Modify saves file after file into one entry).
   * For each file the oldest snapshot wins, so undo goes back to the very first state.
   */
  append(id, { undo, summary, details }) {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return null;
    if (summary) entry.summary = summary;
    if (details) entry.details = details;
    if (undo) {
      const file = path.join(this.dir, `${id}.json`);
      const cur = readJson(file, null) || { exif: [], times: [] };
      const exif = new Map();
      for (const item of [...(cur.exif || []), ...(undo.exif || [])]) {
        const tags = exif.get(item.path) || new Map();
        for (const [tag, value] of item.tags || []) if (!tags.has(tag)) tags.set(tag, value);
        exif.set(item.path, tags);
      }
      const times = new Map();
      for (const item of [...(cur.times || []), ...(undo.times || [])]) if (!times.has(item.path)) times.set(item.path, item);
      // Folders last: putting a file's dates back must not leave a folder's date changed.
      const sorted = [...times.values()].sort((a, b) => Number(Boolean(a.dir)) - Number(Boolean(b.dir)));
      writeJson(file, { exif: [...exif].map(([p, tags]) => ({ path: p, tags: [...tags] })), times: sorted });
      entry.undoable = true;
      entry.reverted = false;
    }
    this._save();
    return entry;
  }

  getUndo(id) {
    return readJson(path.join(this.dir, `${id}.json`), null);
  }

  markReverted(id, info) {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return null;
    entry.reverted = true;
    entry.revertedAt = Date.now();
    entry.revertInfo = info || null;
    this._dropUndo(id);
    this._save();
    return entry;
  }

  remove(id) {
    this.entries = this.entries.filter((e) => e.id !== id);
    this._dropUndo(id);
    this._save();
  }

  clear() {
    for (const e of this.entries) this._dropUndo(e.id);
    this.entries = [];
    this._save();
  }

  _dropUndo(id) {
    fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
  }

  _save() {
    writeJson(this.file, this.entries);
  }
}

module.exports = { Settings, History, DEFAULT_SETTINGS, readJson, writeJson };

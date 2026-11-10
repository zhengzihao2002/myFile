"use strict";

// Only review choices and undo-session identity are persisted. File metadata is
// read afresh on resume so the draft never becomes an authority over the disk.
const fs = require("node:fs");
const path = require("node:path");
const { readJson, writeJson } = require("../lib/store");
const { UserError } = require("../lib/util");
const fileFor = (ctx) => path.join(ctx.runtime.dataDir, "date-review.json");

function load(ctx) {
  const data = readJson(fileFor(ctx), null);
  if (!data || data.version !== 1 || !Array.isArray(data.paths) || !data.paths.every((p) => typeof p === "string" && path.isAbsolute(p))) return null;
  if (!data.state || typeof data.state !== "object" || Array.isArray(data.state)) return null;
  for (const key of ["decisions", "status", "failures"]) {
    if (data.state[key] !== undefined && (!Array.isArray(data.state[key]) || !data.state[key].every((entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string"))) return null;
  }
  if ((data.state.decisions || []).some(([, d]) => !d || !["", "all-exif", "all-created", "all-modified", "one"].includes(d.choice))) return null;
  if ((data.state.status || []).some(([, value]) => !["saved", "partial", "skipped", "failed"].includes(value))) return null;
  for (const key of ["folders", "savedPaths", "fingerprints"]) {
    if (data[key] !== undefined && (!Array.isArray(data[key]) || !data[key].every((entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string"))) return null;
  }
  return data;
}

function save(ctx, { scanId, state }) {
  const scan = ctx.recall(scanId);
  if (!scan || !scan.raws) throw new UserError("This review is out of date. Scan again before saving its session.");
  const data = {
    version: 1, updatedAt: Date.now(), paths: scan.paths,
    state: state || {}, historyId: scan.historyId,
    folders: [...scan.folders], savedPaths: [...(scan.savedPaths || [])],
    fingerprints: [...scan.raws].map(([p, r]) => [p, fingerprint(r)]),
  };
  writeJson(fileFor(ctx), data);
  return { saved: true };
}

function clear(ctx) {
  fs.rmSync(fileFor(ctx), { force: true });
  return { cleared: true };
}

const fingerprint = (r) => JSON.stringify([r.wall, r.subsec, r.storedOffsetMin, r.createdMs, r.modifiedMs]);

function restore(ctx, scan) {
  const data = load(ctx);
  if (!data) return null;
  if (scan.paths && (!scan.paths.length || !scan.paths.every((p) => data.paths.includes(p)))) return null;
  const history = ctx.history.list().find((e) => e.id === data.historyId && !e.reverted);
  if (history) {
    scan.historyId = history.id;
    scan.folders = new Map(data.folders || []);
    scan.savedPaths = new Map(data.savedPaths || []);
  }
  const fingerprints = new Map(data.fingerprints || []);
  scan.savedPaths = new Map([...(scan.savedPaths || [])].filter(([p]) => scan.raws.has(p) && fingerprints.get(p) === fingerprint(scan.raws.get(p))));
  const state = { ...data.state };
  state.status = (Array.isArray(state.status) ? state.status : []).filter(([p]) => scan.raws.has(p) && fingerprints.get(p) === fingerprint(scan.raws.get(p)));
  return state;
}

module.exports = { load, save, clear, restore };

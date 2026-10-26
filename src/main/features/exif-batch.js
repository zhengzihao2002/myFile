"use strict";

// EXIF › Batch Modify
//
// Walks a nested folder of photos and videos and finds the ones whose three
// dates disagree: the EXIF date (taken), the created date and the modified
// date. The user then decides, file by file, which of them wins, and this
// module writes it.
//
// Time zones matter. EXIF stores a wall-clock time ("12:00 in Beijing") and,
// when the camera was kind, a UTC offset; file dates are exact instants. A
// file counts as agreeing when its EXIF time, read in the zone it was taken
// in, is the same instant as its created and modified dates. So a photo taken
// in Beijing and saved with dates matching on a Mac in New York shows its
// file dates 12 or 13 hours earlier than the EXIF wall clock, and it stays
// correct when the files go back to China.
//
// The zone comes from, in this order: the offset stored in the file, the GPS
// position (approximate, near borders it can be wrong), or the user's choice
// for that one file. A photo with none of those is never guessed: it stays in the
// list until its zone is chosen.
//
// Writing a file inside a folder can change the folder's modified date
// (ExifTool works through a temporary file). Every folder involved is noted
// first and put back afterwards; the originals are kept in History.

const fs = require("node:fs");
const path = require("node:path");
const { UserError, checkCancel, newId, throttle } = require("../lib/util");
const { expandMediaPaths } = require("../lib/media");
const { ignoreFor } = require("../lib/ignore");
const { applyTimes, canSetBirthtime } = require("../lib/filetimes");
const tz = require("../lib/tz");
const { parseExifDate } = require("../lib/dates");
const { readInfos, snapshotTags } = require("./exif-copy");
const { previewFor } = require("./exif-show");

const FIELDS = ["exif", "created", "modified"];
// QuickTime stores these as one exact moment (UTC) and no zone.
const ABSOLUTE_TAGS = new Set(["QuickTime:CreateDate", "TrackCreateDate", "MediaCreateDate"]);
const MOVIE_DATE_TAGS = ["QuickTime:CreateDate", "QuickTime:ModifyDate", "TrackCreateDate", "TrackModifyDate", "MediaCreateDate", "MediaModifyDate", "Keys:CreationDate", "UserData:DateTimeOriginal"];
const PHOTO_DATE_TAGS = ["DateTimeOriginal", "CreateDate", "ModifyDate"];
const PHOTO_SUBSEC_TAGS = ["SubSecTimeOriginal", "SubSecTimeDigitized", "SubSecTime"];
const PHOTO_OFFSET_TAGS = ["OffsetTimeOriginal", "OffsetTimeDigitized", "OffsetTime"];

// ---------------------------------------------------------------------------
// Pure logic: which zone, what the dates become
// ---------------------------------------------------------------------------

/** Scan options as the rest of this module wants them. */
function normalizeOptions(options, settings) {
  return {
    includeAll: false,
    useGps: options.useGps !== false,
    tolMs: Math.max(1, Number(options.tolMs) || Number(settings.toleranceMs) || 1000),
    birthSupported: options.birthSupported !== undefined ? Boolean(options.birthSupported) : canSetBirthtime(),
  };
}

/** The time zone to read a file's EXIF wall-clock time in. */
function resolveTz(file, override, opts) {
  // The GPS position only ever *suggests* a zone; the user has to click it.
  const zone = opts.useGps && file.gps ? tz.zoneFromGps(file.gps.lat, file.gps.lon) : null;
  const suggest = zone ? { zone } : null;
  if (override) return { spec: override, kind: "chosen", suggest };
  if (!file.absolute && file.storedOffsetMin !== null && file.storedOffsetMin !== undefined) return { spec: { offsetMin: file.storedOffsetMin }, kind: "stored", suggest };
  // Nothing in the file says where it was taken. This Mac's zone is only used to show something;
  // a photo can't be saved until the user picks its zone.
  // A video's date is one exact moment (UTC), so until a zone is chosen it is shown as UTC.
  return { spec: file.absolute ? { offsetMin: 0 } : { zone: tz.systemZone() }, kind: "unknown", suggest };
}

const TZ_KIND_TEXT = {
  stored: "stored in the file",
  gps: "suggested by the GPS position",
  unknown: "not known: choose it for this file",
  chosen: "chosen by you",
};

/** The instant of the file's EXIF date in a zone, or null without one. */
function exifInstant(file, spec) {
  if (!file.has) return null;
  if (file.absolute) return file.absMs;
  const p = tz.parseExifDate(file.wall);
  if (!p) return null;
  return tz.wallToInstant(p, spec, file.fracMs || 0);
}

/**
 * What a decision does to a file. `decision` = { set: { exif?, created?, modified? }, tz?, writeTz? };
 * `set.modified = "exif"` means "make the modified date equal the EXIF date".
 * Nothing is read or written here.
 */
function computeOutcome(file, decision, opts) {
  const dec = decision || {};
  const birth = opts.birthSupported;
  const zone = resolveTz(file, tz.parseSpec(dec.tz), opts);
  const E = exifInstant(file, zone.spec);
  const before = { exif: E, created: birth ? file.createdMs : null, modified: file.modifiedMs };
  const after = { ...before };
  for (const target of FIELDS) {
    const src = dec.set && dec.set[target];
    if (!src || src === target || !FIELDS.includes(src)) continue;
    if (target === "created" && !birth) continue;
    if (before[src] === null || before[src] === undefined) continue;
    after[target] = before[src];
  }
  const changes = {
    exif: before.exif !== after.exif,
    created: birth && Math.abs(after.created - before.created) >= 1,
    modified: Math.abs(after.modified - before.modified) >= 1,
  };
  const ref = after.exif ?? after.modified;
  const offsetMin = tz.offsetAt(zone.spec, ref);
  // Files keep only an offset ("+08:00"), never a city: choosing Beijing for a file that already says +08:00 changes nothing.
  const sameOffset = !file.absolute && file.storedOffsetMin !== null && file.storedOffsetMin !== undefined && file.storedOffsetMin === offsetMin;
  const writeTz = Boolean(dec.writeTz) && (file.has || changes.exif) && !sameOffset;
  // A photo whose time zone nobody knows can't be judged or saved yet.
  const needsZone = zone.kind === "unknown" && file.has && !file.absolute;
  const values = [after.exif, after.created, after.modified].filter((v) => v !== null && v !== undefined);
  const spread = values.length ? Math.max(...values) - Math.min(...values) : 0;
  return {
    tz: { kind: zone.kind, spec: zone.spec, offsetMin, label: tz.describeSpec(zone.spec, ref), why: TZ_KIND_TEXT[zone.kind], suggest: zone.suggest ? { zone: zone.suggest.zone, label: tz.describeSpec(zone.suggest, ref) } : null },
    before,
    after,
    changes,
    writeTz,
    sameOffset: Boolean(dec.writeTz) && sameOffset,
    newWall: after.exif === null || after.exif === undefined ? null : tz.instantToWall(after.exif, zone.spec),
    keepSubsec: !changes.exif,
    spread,
    needsZone,
    agree: spread <= opts.tolMs && !needsZone,
    anything: changes.exif || changes.created || changes.modified || writeTz,
  };
}

/** The tags to write into the file for an outcome (dates and/or time zone). */
function exifWrites(file, out) {
  const writes = [];
  const offsetText = tz.offsetTextAt(out.tz.spec, out.after.exif ?? out.after.modified);
  if (file.movie) {
    if (out.changes.exif && out.newWall) {
      const zoned = `${out.newWall}${offsetText}`;
      for (const t of MOVIE_DATE_TAGS) writes.push([t, zoned]);
    } else if (out.writeTz && out.before.exif !== null) {
      writes.push(["Keys:CreationDate", `${tz.instantToWall(out.before.exif, out.tz.spec)}${offsetText}`]);
    }
    return writes;
  }
  if (out.changes.exif && out.newWall) {
    for (const t of PHOTO_DATE_TAGS) writes.push([t, out.newWall]);
    for (const t of PHOTO_SUBSEC_TAGS) writes.push([t, null]);
  }
  const hadOffset = file.storedOffsetMin !== null && file.storedOffsetMin !== undefined;
  if ((out.changes.exif && (out.writeTz || hadOffset)) || (!out.changes.exif && out.writeTz)) {
    for (const t of PHOTO_OFFSET_TAGS) writes.push([t, offsetText]);
  }
  return writes;
}

/** Where the three dates stand for a file: which pairs disagree. */
function classify(file, opts) {
  const out = computeOutcome(file, {}, opts);
  const b = out.before;
  const far = (x, y) => x !== null && y !== null && Math.abs(x - y) > opts.tolMs;
  return {
    out,
    agree: out.agree,
    needsZone: out.needsZone,
    pairs: { exifModified: far(b.exif, b.modified), exifCreated: far(b.exif, b.created), createdModified: far(b.created, b.modified) },
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function rawFrom(file, info, st) {
  const date = info && info.date;
  const moment = date ? date.moment : null;
  const absolute = Boolean(info && info.movie && date && ABSOLUTE_TAGS.has(date.tag));
  let storedOffsetMin = null;
  if (moment && moment.offset && !absolute) storedOffsetMin = require("../lib/dates").parseOffset(moment.offset);
  return {
    path: file,
    name: path.basename(file),
    movie: Boolean(info && info.movie),
    has: Boolean(moment),
    tag: date ? date.tag : null,
    source: date ? date.source : null,
    wall: moment ? moment.wall : null,
    fracMs: moment && moment.subsec ? Number(`0.${moment.subsec}`) * 1000 : 0,
    subsec: moment ? moment.subsec : "",
    absolute,
    absMs: absolute && moment ? moment.ms : null,
    storedOffsetMin,
    gps: info && info.gps ? { lat: info.gps.lat, lon: info.gps.lon } : null,
    createdMs: st.birthtimeMs,
    modifiedMs: st.mtimeMs,
  };
}

async function readRaws(ctx, files, { signal, onProgress } = {}) {
  const infos = await readInfos(ctx, files, { signal, onProgress });
  const out = [];
  for (const file of files) {
    checkCancel(signal);
    let st;
    try {
      st = await fs.promises.lstat(file);
    } catch {
      continue;
    }
    out.push(rawFrom(file, infos.get(file), st));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

function listRow(raw, c, root) {
  const out = c.out;
  return {
    path: raw.path,
    rel: path.relative(root, raw.path).split(path.sep).join("/"),
    name: raw.name,
    movie: raw.movie,
    hasExif: raw.has,
    exifMs: out.before.exif,
    createdMs: out.before.created,
    modifiedMs: out.before.modified,
    spreadMs: out.spread,
    needsZone: out.needsZone,
    suggestZone: out.tz.suggest ? out.tz.suggest.zone : null,
    pairs: c.pairs,
    tzKind: out.tz.kind,
    tzLabel: out.tz.label,
  };
}

function classifyAll(scan, opts) {
  const rows = [];
  const counts = { total: scan.raws.size, agree: 0, review: 0, noExif: 0, saved: 0 };
  for (const raw of scan.raws.values()) {
    const c = classify(raw, opts);
    if (c.agree) {
      counts.agree++;
      if (!scan.single) continue;
    }
    counts.review++;
    if (!raw.has) counts.noExif++;
    if (c.out.needsZone) counts.needsZone = (counts.needsZone || 0) + 1;
    rows.push(listRow(raw, c, scan.folder));
  }
  rows.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { rows, counts };
}

async function scan(ctx, { folder, options = {} }, task) {
  if (!folder) throw new UserError("Choose a folder first.");
  let st;
  try {
    st = await fs.promises.stat(folder);
  } catch {
    throw new UserError("That folder can't be opened.");
  }
  // A single file (EXIF › Modify): the same flow, listed even when its dates already agree.
  const single = options.single === true && st.isFile();
  if (!single && !st.isDirectory()) throw new UserError("Choose a folder, not a single file.");
  const file = single ? folder : null;
  if (single) folder = path.dirname(folder);
  const settings = ctx.settings.get();
  const volume = await ctx.volumes.info(folder).catch(() => null);
  const opts = normalizeOptions({ ...options, tolMs: Math.max(Number(settings.toleranceMs) || 1000, volume ? volume.granularityMs : 0) }, settings);

  const report = throttle((p) => task.progress(p), 150);
  const { files, skipped } = await expandMediaPaths([file || folder], {
    ignore: ignoreFor(opts),
    signal: task.signal,
    onProgress: ({ found, current }) => report({ phase: "find", found, current }),
  });
  report.flush();
  const raws = new Map();
  for (const raw of await readRaws(ctx, files, { signal: task.signal, onProgress: (p) => task.progress({ phase: "read", done: p.done, total: p.total, current: p.current }) })) raws.set(raw.path, raw);

  const id = newId("bat");
  const scanData = { id, folder, raws, opts, single, historyId: null, folders: new Map() };
  ctx.remember(id, scanData);
  const { rows, counts } = classifyAll(scanData, opts);
  return { scanId: id, folder, rows, counts, skipped, birthSupported: opts.birthSupported, system: { zone: tz.systemZone(), label: tz.describeSpec({ zone: tz.systemZone() }, Date.now()) }, zones: tz.QUICK_ZONES };
}

function recall(ctx, scanId) {
  const s = ctx.recall(scanId);
  if (!s) throw new UserError("This scan is out of date. Scan the folder again.");
  return s;
}

/** The same scan with other options (default zone, GPS guessing): no re-reading of the files. */
async function reclassify(ctx, { scanId, options = {} }) {
  const s = recall(ctx, scanId);
  s.opts = normalizeOptions({ ...options, tolMs: s.opts.tolMs, birthSupported: s.opts.birthSupported }, ctx.settings.get());
  const { rows, counts } = classifyAll(s, s.opts);
  return { rows, counts };
}

// ---------------------------------------------------------------------------
// One file: preview and what a decision would do
// ---------------------------------------------------------------------------

function textOf(ms, spec) {
  return ms === null || ms === undefined ? null : `${tz.formatInstant(ms, spec)} ${tz.utcLabel(tz.offsetAt(spec, ms))}`;
}

function describeOutcome(raw, out, opts) {
  const sys = { zone: tz.systemZone() };
  const ref = out.before.exif ?? out.before.modified;
  const dash = (w) => w.replace(/:/, "-").replace(/:/, "-");
  // What the file says right now, whatever zone gets chosen: the EXIF date as stored, file dates as Finder shows them.
  const originalText = (key) => {
    if (key === "exif") {
      if (!raw.has) return null;
      if (raw.absolute) return textOf(raw.absMs, { offsetMin: 0 });
      return `${dash(raw.wall)}${raw.storedOffsetMin !== null && raw.storedOffsetMin !== undefined ? ` ${tz.utcLabel(raw.storedOffsetMin)}` : ""}`;
    }
    return textOf(out.before[key], sys);
  };
  const field = (key) => ({
    originalText: originalText(key),
    before: out.before[key],
    after: out.after[key],
    changed: out.changes[key],
    beforeText: textOf(out.before[key], out.tz.spec),
    afterText: textOf(out.after[key], out.tz.spec),
    beforeMac: textOf(out.before[key], sys),
    afterMac: textOf(out.after[key], sys),
  });
  return {
    path: raw.path,
    name: raw.name,
    movie: raw.movie,
    hasExif: raw.has,
    exifSource: raw.source,
    exifAsStored: raw.has ? (raw.absolute ? "one exact moment (UTC), no time zone" : `${raw.wall}${raw.storedOffsetMin !== null ? ` ${require("../lib/dates").offsetString(raw.storedOffsetMin)}` : " (no time zone)"}`) : null,
    tzOriginal: raw.storedOffsetMin !== null && raw.storedOffsetMin !== undefined && !raw.absolute ? tz.utcLabel(raw.storedOffsetMin) : raw.absolute ? "none (one exact moment, UTC)" : "none stored",
    suggest: out.tz.suggest,
    tz: { kind: out.tz.kind, label: out.tz.label, why: out.tz.why, offsetMin: out.tz.offsetMin, zone: out.tz.spec.zone || null, writesInFile: raw.movie ? "Keys:CreationDate" : "OffsetTime tags" },
    mac: { label: tz.describeSpec(sys, ref), same: tz.offsetAt(sys, ref) === out.tz.offsetMin },
    gps: raw.gps,
    fields: { exif: field("exif"), created: opts.birthSupported ? field("created") : null, modified: field("modified") },
    newWall: out.newWall,
    writeTz: out.writeTz,
    sameOffset: out.sameOffset,
    agree: out.agree,
    spreadMs: out.spread,
    needsZone: out.needsZone,
    anything: out.anything,
    writes: exifWrites(raw, out).map(([t]) => t),
  };
}

async function outcome(ctx, { scanId, path: file, decision }) {
  const s = recall(ctx, scanId);
  const raw = s.raws.get(file);
  if (!raw) throw new UserError("That file isn't part of this scan.");
  return describeOutcome(raw, computeOutcome(raw, decision, s.opts), s.opts);
}

async function preview(ctx, { path: file }) {
  return previewFor(ctx, file);
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/** Every folder from a file's parent up to (and including) the scanned folder. */
function folderChain(file, root) {
  const dirs = [];
  let dir = path.dirname(file);
  const stop = path.resolve(root);
  while (true) {
    dirs.push(dir);
    if (path.resolve(dir) === stop || path.dirname(dir) === dir) break;
    dir = path.dirname(dir);
  }
  return dirs;
}

async function apply(ctx, { scanId, items }, task) {
  const s = recall(ctx, scanId);
  const list = (items || []).filter((i) => i && i.path);
  if (!list.length) throw new UserError("Nothing to save.");

  // Remember the folders' dates before touching anything inside them.
  const folderBefore = new Map();
  for (const item of list) {
    for (const dir of folderChain(item.path, s.folder)) {
      if (folderBefore.has(dir) || s.folders.has(dir)) continue;
      try {
        const st = await fs.promises.stat(dir);
        folderBefore.set(dir, { path: dir, mtimeMs: st.mtimeMs, atimeMs: st.atimeMs });
      } catch {
        // folder vanished: nothing to protect
      }
    }
  }
  for (const [dir, v] of folderBefore) s.folders.set(dir, v);
  const dirsInvolved = new Set(list.flatMap((i) => folderChain(i.path, s.folder)));

  const results = [];
  const undoExif = [];
  const undoTimes = [];
  const touched = [];
  let index = 0;
  const birth = s.opts.birthSupported;
  for (const item of list) {
    checkCancel(task.signal);
    task.progress({ phase: "write", done: index, total: list.length, current: path.basename(item.path) });
    index++;
    const result = { path: item.path, name: path.basename(item.path), ok: false };
    results.push(result);
    try {
      // Read the file afresh: it may have changed since the scan.
      const [raw] = await readRaws(ctx, [item.path], { signal: task.signal });
      if (!raw) throw new Error("The file is gone.");
      const out = computeOutcome(raw, item.decision, s.opts);
      if (out.needsZone) throw new UserError("Choose this file's time zone first: it doesn't say where it was taken and has no GPS.");
      if (!out.anything) {
        result.ok = true;
        result.nothing = true;
        s.raws.set(item.path, raw);
        continue;
      }
      const writes = exifWrites(raw, out);
      const st = await fs.promises.lstat(item.path);
      undoTimes.push({ path: item.path, birthMs: st.birthtimeMs, mtimeMs: st.mtimeMs, atimeMs: st.atimeMs });
      if (writes.length) {
        undoExif.push({ path: item.path, tags: await snapshotTags(ctx, item.path, writes, task.signal) });
        await ctx.et.write(item.path, writes, { signal: task.signal });
      }
      // Modified first, created second (setting a modified date earlier than the
      // created date pulls the created date back). Both are always given, so a date
      // the user left alone is put back to what it was after the write.
      const entry = { path: item.path, mtimeMs: out.after.modified };
      if (birth) entry.birthMs = out.after.created;
      const res = await applyTimes([entry], { signal: task.signal });
      if (res.failures.length) throw new Error(res.failures[0].error);
      touched.push(item.path);
      // Check what is on disk now.
      const [fresh] = await readRaws(ctx, [item.path], { signal: task.signal });
      if (fresh) {
        s.raws.set(item.path, fresh);
        result.agree = classify(fresh, s.opts).agree;
      }
      result.ok = true;
    } catch (err) {
      if (err.code === "CANCELLED") throw err;
      result.error = err.message;
    }
  }

  // Put the folders' modified dates back if writing inside them moved them.
  const restore = [];
  for (const dir of dirsInvolved) {
    const was = s.folders.get(dir);
    if (!was) continue;
    try {
      const st = await fs.promises.stat(dir);
      if (Math.abs(st.mtimeMs - was.mtimeMs) >= 1) restore.push({ path: dir, mtimeMs: was.mtimeMs, atimeMs: was.atimeMs });
    } catch {
      // gone
    }
  }
  let foldersRestored = 0;
  if (restore.length) {
    const res = await applyTimes(restore, { signal: task.signal });
    foldersRestored = restore.length - res.failures.length;
  }

  const ok = results.filter((r) => r.ok && !r.nothing).length;
  const failed = results.filter((r) => !r.ok).length;
  let historyId = s.historyId;
  if (undoTimes.length || undoExif.length) {
    const folderEntries = [...folderBefore.values()].map((f) => ({ path: f.path, mtimeMs: f.mtimeMs, atimeMs: f.atimeMs, dir: true }));
    const undo = { exif: undoExif, times: [...undoTimes, ...folderEntries] };
    const done = (s.saved = (s.saved || 0) + ok);
    const summary = `${done} file${done === 1 ? "" : "s"} fixed${foldersRestored || s.foldersRestored ? `; folder dates kept (${(s.foldersRestored = (s.foldersRestored || 0) + foldersRestored)} put back)` : ""}`;
    const details = { folder: s.folder, folders: [...s.folders.values()].map((f) => ({ path: f.path, mtimeMs: f.mtimeMs })) };
    if (historyId && ctx.history.append(historyId, { undo, summary, details })) {
      // added to this session's entry
    } else {
      const entry = ctx.history.add({ type: "exif-batch", title: s.single ? `Fixed ${path.basename([...s.raws.keys()][0] || s.folder)}` : `Batch fix in ${path.basename(s.folder) || s.folder}`, summary, details, undo });
      historyId = s.historyId = entry.id;
    }
  }
  return { results, ok, failed, foldersRestored, historyId, undoable: Boolean(historyId) };
}

/** The quick time zones and this Mac's own, for the pickers. */
async function zones() {
  const zone = tz.systemZone();
  return { zones: tz.QUICK_ZONES, system: { zone, label: tz.describeSpec({ zone }, Date.now()) } };
}

module.exports = { zones, scan, reclassify, outcome, preview, apply, computeOutcome, exifWrites, classify, normalizeOptions, resolveTz, folderChain };

"use strict";

// EXIF › Modify › Copy from reference
//
// Copies the date/time (with sub-seconds and time zone), GPS location and,
// optionally, camera details from one reference file to any number of
// targets. Photos get EXIF tags; QuickTime/MP4 videos get the QuickTime and
// Apple "Keys" tags that Photos and Finder read. Works across types too:
// a photo can be the reference for a video and the other way round.

const fs = require("node:fs");
const path = require("node:path");
const { UserError, checkCancel } = require("../lib/util");
const { expandMediaPaths, isQuickTime, mediaKind } = require("../lib/media");
const { bestDate, momentText, momentWithZone } = require("../lib/dates");
const { applyTimes } = require("../lib/filetimes");
const { ignoreFor } = require("../lib/ignore");

const READ_ARGS = [
  "-G0:1", "-a", "-s",
  "-time:all", "-gps:all", "-Keys:GPSCoordinates", "-UserData:GPSCoordinates",
  "-Composite:GPSLatitude#", "-Composite:GPSLongitude#", "-Composite:GPSAltitude#",
  "-Make", "-Model", "-LensMake", "-LensModel",
];

// QuickTime header dates always exist and can't be deleted, only changed.
const NOT_DELETABLE = /^(QuickTime:(Create|Modify)Date|Track(Create|Modify)Date|Media(Create|Modify)Date)$/;

function isMovieFile(file) {
  return isQuickTime(file) || mediaKind(file) === "video";
}

function tagValue(tags, tagName) {
  for (const [key, value] of Object.entries(tags)) {
    if (key.slice(key.lastIndexOf(":") + 1) === tagName && value !== "") return value;
  }
  return null;
}

function interpret(file, tags) {
  const movie = isMovieFile(file);
  const lat = Number(tags["Composite:GPSLatitude"]);
  const lon = Number(tags["Composite:GPSLongitude"]);
  const altRaw = tags["Composite:GPSAltitude"];
  const gps = tags["Composite:GPSLatitude"] !== undefined && Number.isFinite(lat) && Number.isFinite(lon)
    ? { lat, lon, alt: altRaw !== undefined && Number.isFinite(Number(altRaw)) ? Number(altRaw) : null }
    : null;
  const camera = {};
  for (const t of ["Make", "Model", "LensMake", "LensModel"]) {
    const v = tagValue(tags, t);
    if (v !== null) camera[t] = String(v);
  }
  return { file, movie, tags, date: bestDate(tags, { movie }), gps, camera };
}

/** Reads date/GPS/camera info for many files, 100 per ExifTool call. */
async function readInfos(ctx, files, { signal, onProgress } = {}) {
  const out = new Map();
  for (let i = 0; i < files.length; i += 100) {
    checkCancel(signal);
    const chunk = files.slice(i, i + 100);
    const rows = await ctx.et.readJson(chunk, READ_ARGS, { signal });
    const bySource = new Map(rows.map((r) => [String(r.SourceFile).normalize("NFC"), r]));
    for (const file of chunk) {
      const row = bySource.get(file.normalize("NFC")) || {};
      delete row.SourceFile;
      out.set(file, interpret(file, row));
    }
    if (onProgress) onProgress({ done: Math.min(i + 100, files.length), total: files.length, phase: "read" });
  }
  return out;
}

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function gpsText(gps) {
  if (!gps) return "";
  const alt = gps.alt !== null && gps.alt !== undefined ? ` · ${round(gps.alt, 1)} m` : "";
  return `${round(gps.lat, 6).toFixed(6)}, ${round(gps.lon, 6).toFixed(6)}${alt}`;
}

/** The tag assignments that make `movie`/photo target match the reference. */
function buildWrites(ref, options, movie) {
  const writes = [];
  if (options.date && ref.date) {
    const m = ref.date.moment;
    if (!movie) {
      for (const t of ["DateTimeOriginal", "CreateDate", "ModifyDate"]) writes.push([t, m.wall]);
      for (const t of ["SubSecTimeOriginal", "SubSecTimeDigitized", "SubSecTime"]) writes.push([t, m.subsec || null]);
      for (const t of ["OffsetTimeOriginal", "OffsetTimeDigitized", "OffsetTime"]) writes.push([t, m.offset || null]);
    } else {
      // QuickTime stores UTC; with QuickTimeUTC=1 ExifTool converts using the zone we give it.
      const zoned = momentWithZone({ ...m, subsec: "" });
      for (const t of ["QuickTime:CreateDate", "QuickTime:ModifyDate", "TrackCreateDate", "TrackModifyDate", "MediaCreateDate", "MediaModifyDate", "Keys:CreationDate", "UserData:DateTimeOriginal"]) {
        writes.push([t, zoned]);
      }
    }
  }
  if (options.gps && ref.gps) {
    const { lat, lon, alt } = ref.gps;
    if (!movie) {
      writes.push(["GPSLatitude#", Math.abs(lat)], ["GPSLatitudeRef", lat < 0 ? "S" : "N"]);
      writes.push(["GPSLongitude#", Math.abs(lon)], ["GPSLongitudeRef", lon < 0 ? "W" : "E"]);
      if (alt !== null) writes.push(["GPSAltitude#", Math.abs(alt)], ["GPSAltitudeRef#", alt < 0 ? 1 : 0]);
      else writes.push(["GPSAltitude", null], ["GPSAltitudeRef", null]);
    } else {
      writes.push(["Keys:GPSCoordinates", `${lat}, ${lon}${alt !== null ? `, ${alt}` : ""}`]);
    }
  }
  if (options.camera) {
    // QuickTime's Keys atom has Make and Model; ExifTool picks a home for the lens tags.
    for (const [t, v] of Object.entries(ref.camera)) writes.push([movie && (t === "Make" || t === "Model") ? `Keys:${t}` : t, v]);
  }
  return writes;
}

function describe(info) {
  return {
    date: info.date ? momentText(info.date.moment) : "",
    dateMs: info.date ? info.date.moment.ms : null,
    gps: gpsText(info.gps),
    camera: [info.camera.Make, info.camera.Model].filter(Boolean).join(" "),
  };
}

async function gatherTargets(ctx, reference, targets, options, task) {
  const { files, skipped } = await expandMediaPaths(targets, { ignore: ignoreFor(options), signal: task.signal });
  const refKey = path.resolve(reference).normalize("NFC");
  const list = files.filter((f) => path.resolve(f).normalize("NFC") !== refKey);
  return { files: list, skipped, droppedReference: list.length !== files.length };
}

async function copyPlan(ctx, { reference, targets, options = {} }, task) {
  const opts = { date: true, gps: true, camera: false, all: false, fileDates: true, ...options };
  try {
    if (!(await fs.promises.stat(reference)).isFile()) throw new Error();
  } catch {
    throw new UserError("The reference must be a single photo or video file.");
  }
  const refInfo = (await readInfos(ctx, [reference], { signal: task.signal })).get(reference);
  const { files, skipped, droppedReference } = await gatherTargets(ctx, reference, targets || [], opts, task);
  const infos = await readInfos(ctx, files, { signal: task.signal, onProgress: task.progress });

  const ref = describe(refInfo);
  const warnings = [];
  if (opts.date && !refInfo.date) warnings.push("The reference has no date taken, so dates won't change.");
  if (opts.gps && !refInfo.gps) warnings.push("The reference has no GPS location, so locations won't change.");
  if (droppedReference) warnings.push("The reference file was also in the targets; it was left out.");

  const rows = files.map((file) => {
    const info = infos.get(file);
    const cur = describe(info);
    const writes = buildWrites(refInfo, opts, info.movie);
    const dateChange = Boolean(opts.date && refInfo.date && cur.date !== ref.date);
    const gpsChange = Boolean(opts.gps && refInfo.gps && cur.gps !== ref.gps);
    const cameraChange = Boolean(opts.camera && Object.keys(refInfo.camera).length && cur.camera !== ref.camera);
    return {
      path: file,
      name: path.basename(file),
      movie: info.movie,
      current: cur,
      next: {
        date: opts.date && refInfo.date ? ref.date : cur.date,
        gps: opts.gps && refInfo.gps ? ref.gps : cur.gps,
        camera: opts.camera && ref.camera ? ref.camera : cur.camera,
      },
      changes: { date: dateChange, gps: gpsChange, camera: cameraChange },
      willWrite: writes.length > 0 || opts.all,
    };
  });

  return {
    reference: {
      path: reference,
      name: path.basename(reference),
      movie: refInfo.movie,
      date: ref.date,
      dateSource: refInfo.date ? refInfo.date.source : null,
      gps: ref.gps,
      gpsValue: refInfo.gps,
      camera: ref.camera,
    },
    rows,
    skipped,
    warnings,
    options: opts,
  };
}

/** Current values of exactly the tags we're about to write (for undo). */
async function snapshotTags(ctx, file, writes, signal) {
  const args = ["-s", ...writes.map(([t]) => `-${t}`)];
  const [row = {}] = await ctx.et.readJson([file], args, { signal });
  return writes
    .map(([tag]) => {
      const key = tag.replace(/#$/, "").replace(/^.*:/, "");
      const value = row[key];
      if (value === undefined && NOT_DELETABLE.test(tag.replace(/#$/, ""))) return null;
      return [tag, value === undefined ? null : String(value)];
    })
    .filter(Boolean);
}

async function copyApply(ctx, { reference, targets, options = {} }, task) {
  const opts = { date: true, gps: true, camera: false, all: false, fileDates: true, ...options };
  const plan = await copyPlan(ctx, { reference, targets, options: opts }, { ...task, progress: () => {} });
  const refInfo = (await readInfos(ctx, [reference], { signal: task.signal })).get(reference);
  const rows = plan.rows.filter((r) => r.willWrite);

  const results = [];
  const undoExif = [];
  const undoTimes = [];
  const succeeded = [];
  let index = 0;
  for (const row of rows) {
    checkCancel(task.signal);
    task.progress({ done: index, total: rows.length, current: row.name, phase: "write" });
    index++;
    const writes = buildWrites(refInfo, opts, row.movie);
    try {
      const st = await fs.promises.lstat(row.path);
      undoTimes.push({ path: row.path, birthMs: st.birthtimeMs, mtimeMs: st.mtimeMs, atimeMs: st.atimeMs });
      if (!opts.all) undoExif.push({ path: row.path, tags: await snapshotTags(ctx, row.path, writes, task.signal) });
      const extraArgs = opts.all ? ["-tagsFromFile", reference, "-all:all"] : [];
      const res = await ctx.et.write(row.path, writes, { extraArgs, signal: task.signal });
      results.push({ path: row.path, name: row.name, ok: true, warnings: res.warnings, updated: res.updated > 0 });
      succeeded.push(row.path);
    } catch (err) {
      if (err.code === "CANCELLED") throw err;
      results.push({ path: row.path, name: row.name, ok: false, error: err.message });
    }
  }

  let timeFailures = [];
  if (opts.fileDates && refInfo.date && succeeded.length) {
    task.progress({ done: rows.length, total: rows.length, phase: "dates" });
    const ms = refInfo.date.moment.ms;
    const res = await applyTimes(succeeded.map((p) => ({ path: p, birthMs: ms, mtimeMs: ms })), { signal: task.signal });
    timeFailures = res.failures;
    for (const f of res.failures) {
      const r = results.find((x) => x.path === f.path);
      if (r) (r.warnings = r.warnings || []).push(f.error);
    }
  }

  const ok = results.filter((r) => r.ok).length;
  const entry = ctx.history.add({
    type: "exif-copy",
    title: `Copied metadata from ${path.basename(reference)}`,
    summary: `${ok} of ${rows.length} file${rows.length === 1 ? "" : "s"} updated${opts.all ? " (all metadata)" : ""}`,
    details: { reference, options: opts, files: results.map((r) => ({ path: r.path, ok: r.ok, error: r.error || null })) },
    // "All metadata" rewrites tags we can't list in advance, so it can't be undone.
    undo: opts.all
      ? null
      : {
          exif: undoExif.filter((u) => succeeded.includes(u.path)),
          times: undoTimes.filter((u) => succeeded.includes(u.path)),
        },
  });
  return { results, ok, failed: results.length - ok, timeFailures, historyId: entry.id, undoable: entry.undoable };
}

module.exports = { copyPlan, copyApply, readInfos, buildWrites, gpsText, interpret, isMovieFile, snapshotTags };

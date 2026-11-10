"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeJpeg, makeMovie: makeMovieAt, tmpDir, testContext, readTags, setMtime } = require("./helpers");
const tz = require("../src/main/lib/tz");
const batch = require("../src/main/features/exif-batch");

const { ctx, et, call } = testContext();
test.after(() => et.close());

const BEIJING = { zone: "Asia/Shanghai" };
const NEW_YORK = { zone: "America/New_York" };
const OPTS = { useGps: true, tolMs: 1000, birthSupported: true };

test("time zone maths: Beijing wall clock to an instant, and the New York equivalent", () => {
  const may = tz.parseExifDate("2023:05:01 12:00:00");
  const instant = tz.wallToInstant(may, BEIJING);
  assert.equal(new Date(instant).toISOString(), "2023-05-01T04:00:00.000Z");
  assert.equal(tz.instantToWall(instant, NEW_YORK), "2023:05:01 00:00:00", "12 hours earlier in summer (EDT)");
  const winter = tz.wallToInstant(tz.parseExifDate("2023:01:15 12:00:00"), BEIJING);
  assert.equal(tz.instantToWall(winter, NEW_YORK), "2023:01:14 23:00:00", "13 hours earlier in winter (EST)");
  assert.equal(tz.instantToWall(winter, { offsetMin: 480 }), "2023:01:15 12:00:00");
  assert.equal(tz.offsetTextAt(NEW_YORK, instant), "-04:00");
  assert.equal(tz.offsetTextAt(NEW_YORK, winter), "-05:00");
});

test("GPS positions give a time zone, and choices parse", () => {
  assert.equal(tz.zoneFromGps(39.9042, 116.4074), "Asia/Shanghai");
  assert.equal(tz.zoneFromGps(40.7128, -74.006), "America/New_York");
  assert.equal(tz.zoneFromGps(91, 0), null);
  assert.deepEqual(tz.parseSpec("+08:00"), { offsetMin: 480 });
  assert.deepEqual(tz.parseSpec("-5"), { offsetMin: -300 });
  assert.deepEqual(tz.parseSpec("Asia/Shanghai"), { zone: "Asia/Shanghai" });
  assert.equal(tz.parseSpec("Not/AZone"), null);
  assert.equal(tz.parseSpec(""), null);
});

function file(over = {}) {
  return { movie: false, has: true, wall: "2023:05:01 12:00:00", fracMs: 0, subsec: "", absolute: false, absMs: null, storedOffsetMin: 480, gps: null, createdMs: 0, modifiedMs: 0, ...over };
}
const at = (iso) => Date.parse(iso);

test("a photo whose dates agree in its own time zone needs nothing, wherever the Mac is", () => {
  const f = file({ createdMs: at("2023-05-01T04:00:00Z"), modifiedMs: at("2023-05-01T04:00:00Z") });
  assert.equal(batch.classify(f, OPTS).agree, true);
  // Same file dates read as if they were the wall clock: 8 hours apart from the truth.
  const off = file({ createdMs: at("2023-05-01T12:00:00Z"), modifiedMs: at("2023-05-01T12:00:00Z") });
  const c = batch.classify(off, OPTS);
  assert.equal(c.agree, false);
  assert.equal(c.pairs.exifModified, true);
  assert.equal(c.pairs.createdModified, false);
});

test("a decision changes only what was asked, and says whether everything then agrees", () => {
  const f = file({ createdMs: at("2023-05-01T12:00:00Z"), modifiedMs: at("2023-06-01T00:00:00Z") });
  let out = batch.computeOutcome(f, { set: { created: "exif", modified: "exif" } }, OPTS);
  assert.equal(out.after.created, at("2023-05-01T04:00:00Z"));
  assert.equal(out.after.modified, at("2023-05-01T04:00:00Z"));
  assert.equal(out.changes.exif, false);
  assert.equal(out.agree, true);

  out = batch.computeOutcome(f, { set: { modified: "created" } }, OPTS);
  assert.equal(out.after.modified, f.createdMs);
  assert.equal(out.changes.created, false);
  assert.equal(out.agree, false, "the EXIF date still disagrees");

  out = batch.computeOutcome(f, { set: { exif: "modified", created: "modified" } }, OPTS);
  assert.equal(out.changes.exif, true);
  assert.equal(out.newWall, "2023:06:01 08:00:00", "shown on the clocks of the file's own zone (+08:00)");
  assert.deepEqual(batch.exifWrites(f, out).filter(([t]) => /^OffsetTime/.test(t)).map(([, v]) => v), ["+08:00", "+08:00", "+08:00"], "an offset the file already had is kept up to date");
  assert.equal(out.agree, true);

  out = batch.computeOutcome(f, {}, OPTS);
  assert.equal(out.anything, false);
});

test("a photo whose time zone nobody knows is never guessed: the user has to choose it", () => {
  const f = file({ storedOffsetMin: null, createdMs: at("2023-05-01T04:00:00Z"), modifiedMs: at("2023-05-01T04:00:00Z") });
  const unknown = batch.computeOutcome(f, {}, OPTS);
  assert.equal(unknown.tz.kind, "unknown");
  assert.equal(unknown.needsZone, true);
  assert.equal(batch.classify(f, OPTS).agree, false, "even if the dates happen to line up on this Mac, it stays in the list");
  // GPS can only suggest: the user still has to click it.
  const gps = { ...f, gps: { lat: 39.9042, lon: 116.4074 } };
  const suggested = batch.computeOutcome(gps, {}, OPTS);
  assert.equal(suggested.tz.kind, "unknown");
  assert.equal(suggested.needsZone, true);
  assert.equal(suggested.tz.suggest.zone, "Asia/Shanghai");
  assert.equal(batch.computeOutcome(gps, { tz: "Asia/Shanghai" }, OPTS).agree, true, "12:00 in Beijing is 04:00Z once chosen");
  assert.equal(batch.computeOutcome(gps, {}, { ...OPTS, useGps: false }).tz.suggest, null, "GPS suggestions switched off");
  // The user chooses a zone for this file and keeps it in the file.
  const out = batch.computeOutcome(f, { tz: "America/New_York", writeTz: true, set: { created: "exif", modified: "exif" } }, OPTS);
  assert.equal(out.tz.kind, "chosen");
  assert.equal(out.needsZone, false);
  assert.equal(out.after.modified, at("2023-05-01T16:00:00Z"));
  assert.deepEqual(batch.exifWrites(f, out), [["OffsetTimeOriginal", "-04:00"], ["OffsetTimeDigitized", "-04:00"], ["OffsetTime", "-04:00"]]);
  // A file without an EXIF date has no wall clock to read, so it needs no zone.
  assert.equal(batch.computeOutcome(file({ has: false, wall: null, storedOffsetMin: null }), {}, OPTS).needsZone, false);
});

test("videos: QuickTime dates are exact moments and need no zone", () => {
  const v = file({ movie: true, absolute: true, absMs: at("2023-05-01T04:00:00Z"), storedOffsetMin: null, createdMs: at("2023-05-01T04:00:00Z"), modifiedMs: at("2023-05-01T04:00:00Z") });
  assert.equal(batch.classify(v, OPTS).agree, true);
  const out = batch.computeOutcome(v, { tz: "Asia/Shanghai", writeTz: true }, OPTS);
  assert.equal(out.changes.exif, false);
  assert.deepEqual(batch.exifWrites(v, out), [["Keys:CreationDate", "2023:05:01 12:00:00+08:00"]]);
  const set = batch.computeOutcome(v, { tz: "Asia/Shanghai", set: { exif: "modified" } }, { ...OPTS });
  assert.equal(set.changes.exif, false, "already the same moment");
});

// ---------------------------------------------------------------------------
// On disk
// ---------------------------------------------------------------------------

async function photo(dir, name, tags, mtimeIso) {
  const f = makeJpeg(path.join(dir, name));
  if (tags) await et.write(f, tags);
  if (mtimeIso) setMtime(f, Date.parse(mtimeIso));
  return f;
}

async function makeTree() {
  const root = tmpDir("batch");
  const sub = path.join(root, "trip", "day1");
  fs.mkdirSync(sub, { recursive: true });
  const taken = [["DateTimeOriginal", "2023:05:01 12:00:00"], ["OffsetTimeOriginal", "+08:00"]];
  const files = {
    good: await photo(root, "good.jpg", taken, "2023-05-01T04:00:00Z"),
    wrongZone: await photo(sub, "wrong.jpg", taken, "2023-05-01T12:00:00Z"),
    gps: await photo(sub, "gps.jpg", [["DateTimeOriginal", "2023:05:01 12:00:00"], ["GPSLatitude#", 39.9], ["GPSLatitudeRef", "N"], ["GPSLongitude#", 116.4], ["GPSLongitudeRef", "E"]], "2023-05-01T04:00:00Z"),
    none: await photo(sub, "none.jpg", null, "2023-05-01T04:00:00Z"),
  };
  // Folders get known dates so we can see whether they move.
  for (const d of [sub, path.join(root, "trip"), root]) setMtime(d, Date.parse("2020-02-02T02:02:02Z"));
  return { root, sub, files };
}

test("scan finds the files whose dates disagree and leaves the rest alone", async () => {
  const { root, files } = await makeTree();
  const r = await call("exif.batchScan", { folder: root, options: {} });
  assert.equal(r.counts.total, 4);
  const names = r.rows.map((x) => x.name).sort();
  // good agrees; none has no EXIF date and only one file date to compare, so it agrees too.
  // gps.jpg waits for its zone to be clicked.
  assert.deepEqual(names, ["gps.jpg", "wrong.jpg"]);
  assert.equal(r.counts.agree, 2);
  assert.equal(r.rows.find((x) => x.name === "gps.jpg").suggestZone, "Asia/Shanghai");
  const row = r.rows.find((x) => x.name === "wrong.jpg");
  assert.equal(row.rel, "trip/day1/wrong.jpg");
  assert.equal(row.tzKind, "stored");
  assert.equal(row.pairs.exifModified, true);

  // Without GPS suggestions it is the same, just without the suggestion.
  const noGps = await call("exif.batchClassify", { scanId: r.scanId, options: { useGps: false } });
  assert.deepEqual(noGps.rows.map((x) => x.name).sort(), ["gps.jpg", "wrong.jpg"]);
  assert.equal(noGps.rows.find((x) => x.name === "gps.jpg").needsZone, true);
  assert.equal(noGps.counts.needsZone, 1);
  assert.equal(noGps.rows.find((x) => x.name === "gps.jpg").suggestZone, null);
  assert.ok(files.good);
});

test("saving a decision fixes the dates, keeps folder dates where they were, and can be undone", async () => {
  const { root, sub, files } = await makeTree();
  const scan = await call("exif.batchScan", { folder: root, options: {} });
  const target = files.wrongZone;
  const outcome = await call("exif.batchOutcome", { scanId: scan.scanId, path: target, decision: { set: { modified: "exif", created: "exif" } } });
  assert.equal(outcome.fields.modified.afterText.startsWith("2023-05-01 12:00:00 UTC+08:00"), true);
  assert.equal(outcome.agree, true);

  const res = await call("exif.batchApply", { scanId: scan.scanId, items: [{ path: target, decision: { set: { modified: "exif", created: "exif" } } }] });
  assert.equal(res.ok, 1, JSON.stringify(res.results));
  assert.equal(res.results[0].agree, true);
  assert.equal(fs.statSync(target).mtimeMs, Date.parse("2023-05-01T04:00:00Z"));
  for (const d of [sub, path.dirname(sub), root]) assert.equal(fs.statSync(d).mtimeMs, Date.parse("2020-02-02T02:02:02Z"), `${path.basename(d)} keeps its modified date`);

  // A rescan shows nothing left to do.
  const again = await call("exif.batchScan", { folder: root, options: {} });
  assert.deepEqual(again.rows.map((x) => x.name), ["gps.jpg"], "only the photo waiting for its zone is left");

  // Undo puts the old modified date and the folder dates back.
  const entry = ctx.history.list().find((e) => e.id === res.historyId);
  assert.equal(entry.type, "exif-batch");
  const undo = await call("history.revert", { id: res.historyId });
  assert.equal(undo.failures.length, 0, JSON.stringify(undo.failures));
  assert.equal(fs.statSync(target).mtimeMs, Date.parse("2023-05-01T12:00:00Z"));
  assert.equal(fs.statSync(sub).mtimeMs, Date.parse("2020-02-02T02:02:02Z"));
});

test("changing the EXIF date from the modified date writes it in the file's own time zone", async () => {
  const { root, files } = await makeTree();
  const scan = await call("exif.batchScan", { folder: root, options: {} });
  const target = files.wrongZone; // modified 12:00Z, EXIF 12:00 +08:00 (= 04:00Z)
  const res = await call("exif.batchApply", { scanId: scan.scanId, items: [{ path: target, decision: { set: { exif: "modified", created: "modified" } } }] });
  assert.equal(res.ok, 1, JSON.stringify(res.results));
  const t = await readTags(et, target, ["DateTimeOriginal", "OffsetTimeOriginal", "CreateDate"]);
  assert.equal(t.DateTimeOriginal, "2023:05:01 20:00:00", "12:00Z is 20:00 in +08:00");
  assert.equal(t.OffsetTimeOriginal, "+08:00");
  assert.equal(fs.statSync(target).mtimeMs, Date.parse("2023-05-01T12:00:00Z"), "the modified date is untouched");
  assert.equal(res.results[0].agree, true);
  // Writing the tag moved the folder's date (ExifTool works through a temporary file); it was put back.
  assert.ok(res.foldersRestored >= 1, `folders put back: ${res.foldersRestored}`);
  assert.equal(fs.statSync(path.dirname(target)).mtimeMs, Date.parse("2020-02-02T02:02:02Z"));
  const hist = ctx.history.list().find((e) => e.id === res.historyId);
  assert.ok(hist.details.folders.some((f) => f.path === path.dirname(target) && f.mtimeMs === Date.parse("2020-02-02T02:02:02Z")), "the original folder dates are saved in History");
});

test("a file with no time zone can be given one, and later saves join the same History entry", async () => {
  const { root, sub, files } = await makeTree();
  const scan = await call("exif.batchScan", { folder: root, options: { useGps: false } });
  const gpsFile = files.gps;
  const none = files.none;
  const first = await call("exif.batchApply", { scanId: scan.scanId, items: [{ path: gpsFile, decision: { tz: "America/New_York", writeTz: true } }] });
  assert.equal(first.ok, 1, JSON.stringify(first.results));
  const t = await readTags(et, gpsFile, ["OffsetTimeOriginal"]);
  assert.equal(t.OffsetTimeOriginal, "-04:00");
  const second = await call("exif.batchApply", { scanId: scan.scanId, items: [{ path: none, decision: { set: { exif: "modified" }, tz: "Asia/Shanghai", writeTz: true } }] });
  assert.equal(second.ok, 1, JSON.stringify(second.results));
  assert.equal(second.historyId, first.historyId, "one entry for the whole session");
  const tags = await readTags(et, none, ["DateTimeOriginal", "OffsetTimeOriginal"]);
  assert.equal(tags.DateTimeOriginal, "2023:05:01 12:00:00");
  assert.equal(tags.OffsetTimeOriginal, "+08:00");
  assert.equal(fs.statSync(sub).mtimeMs, Date.parse("2020-02-02T02:02:02Z"));

  const undo = await call("history.revert", { id: first.historyId });
  assert.equal(undo.failures.length, 0, JSON.stringify(undo.failures));
  const back = await readTags(et, gpsFile, ["OffsetTimeOriginal"]);
  assert.ok(back.OffsetTimeOriginal === undefined || back.OffsetTimeOriginal === "");
  const noExif = await readTags(et, none, ["DateTimeOriginal"]);
  assert.ok(noExif.DateTimeOriginal === undefined || noExif.DateTimeOriginal === "");
  assert.equal(fs.statSync(sub).mtimeMs, Date.parse("2020-02-02T02:02:02Z"), "folder date survives the undo too");
});

test("a file whose zone is unknown can't be saved until its zone is chosen, one file at a time", async () => {
  const root = tmpDir("unzoned");
  const f = await photo(root, "a.jpg", [["DateTimeOriginal", "2023:05:01 12:00:00"]], "2023-05-01T04:00:00Z");
  const scan = await call("exif.batchScan", { folder: root, options: {} });
  assert.equal(scan.rows.length, 1);
  assert.equal(scan.rows[0].needsZone, true);
  const refused = await call("exif.batchApply", { scanId: scan.scanId, items: [{ path: f, decision: { set: { modified: "exif" } } }] });
  assert.equal(refused.ok, 0);
  assert.match(refused.results[0].error, /Choose this file's time zone/);
  const saved = await call("exif.batchApply", { scanId: scan.scanId, items: [{ path: f, decision: { tz: "Asia/Shanghai", writeTz: true, set: { modified: "exif" } } }] });
  assert.equal(saved.ok, 1, JSON.stringify(saved.results));
  assert.equal(fs.statSync(f).mtimeMs, Date.parse("2023-05-01T04:00:00Z"));
  const again = await call("exif.batchScan", { folder: root, options: {} });
  assert.equal(again.rows.length, 0, "the zone is now in the file, so it agrees");
});

test("a single file can be scanned and edited, even when its dates already agree", async () => {
  const root = tmpDir("batch-one");
  const file = makeJpeg(path.join(root, "one.jpg"));
  await et.write(file, [["DateTimeOriginal", "2020:03:04 05:06:07"], ["OffsetTimeOriginal", "+08:00"]]);
  const when = tz.wallToInstant(tz.parseExifDate("2020:03:04 05:06:07"), { offsetMin: 480 });
  setMtime(file, when);
  const scan = await call("exif.batchScan", { folder: file, options: { single: true } });
  assert.equal(scan.rows.length, 1, "listed although everything agrees");
  assert.equal(scan.rows[0].path, file);
  const folderBefore = fs.statSync(root).mtimeMs;
  const res = await call("exif.batchApply", { scanId: scan.scanId, items: [{ path: file, decision: { set: {}, tz: "America/New_York", writeTz: true } }] });
  assert.equal(res.results[0].ok, true);
  assert.equal(Math.abs(fs.statSync(root).mtimeMs - folderBefore) < 5, true, "parent folder date kept");
  await assert.rejects(call("exif.batchScan", { folder: file, options: {} }), /not a single file/);
});

test("Modify reviews every loose photo and video, including agreeing dates, missing dates and unknown zones", async () => {
  const root = tmpDir("modify-files");
  const matching = await photo(root, "matching.jpg", [["DateTimeOriginal", "2023:05:01 12:00:00"], ["OffsetTimeOriginal", "+08:00"]], "2023-05-01T04:00:00Z");
  const unknown = await photo(root, "unknown.jpg", [["DateTimeOriginal", "2023:05:01 12:00:00"]], "2023-05-01T04:00:00Z");
  const noDate = makeJpeg(path.join(root, "no-date.jpg"));
  const movie = makeMovieAt(path.join(root, "clip.mov"));
  await et.write(movie, [["QuickTime:CreateDate", "2010:08:01 09:08:27Z"]]);
  setMtime(movie, at("2010-08-01T09:08:27Z"));
  const scan = await call("exif.batchScan", { paths: [matching, movie, noDate, unknown, path.join(root, "nested", "..", "matching.jpg")], options: { reviewAll: true, birthSupported: false } });
  assert.deepEqual(scan.paths, [matching, movie, noDate, unknown], "repeated normalized selections are kept once");
  assert.equal(scan.single, false);
  assert.equal(scan.reviewAll, true);
  assert.equal(scan.counts.total, 4);
  assert.equal(scan.rows.length, 4, "all four files have the detailed editor, including files whose dates already agree");
  assert.equal(scan.rows.find((r) => r.path === unknown).needsZone, true);
  assert.equal(scan.rows.find((r) => r.path === noDate).hasExif, false);
  assert.equal(scan.rows.find((r) => r.path === movie).movie, true);
  assert.ok(scan.counts.agree >= 2);
  const reclassified = await call("exif.batchClassify", { scanId: scan.scanId, options: { useGps: false } });
  assert.equal(reclassified.rows.length, 4, "changing suggestions never removes agreeing files from a Modify queue");
  const single = await call("exif.batchScan", { paths: [matching], options: { reviewAll: true, birthSupported: false } });
  assert.equal(single.single, true);
  assert.deepEqual(single.rows, scan.rows.filter((r) => r.path === matching), "single and multiple selections use identical file details");
});

test("Modify recursively reviews folders and deduplicates overlapping folders and loose files", async () => {
  const root = tmpDir("modify-folders");
  const nested = path.join(root, "trip", "day1");
  const a = await photo(nested, "photo.jpg", [["DateTimeOriginal", "2023:05:01 12:00:00"], ["OffsetTimeOriginal", "+08:00"]], "2023-05-01T04:00:00Z");
  const b = makeMovieAt(path.join(root, "trip", "movie.mov"));
  fs.writeFileSync(path.join(root, "notes.txt"), "not media");
  makeJpeg(path.join(root, "._system.jpg"));
  const missing = path.join(root, "missing.jpg");
  const scan = await call("exif.batchScan", { paths: [nested, root, a, root, missing], options: { reviewAll: true, birthSupported: false } });
  assert.equal(scan.single, false);
  assert.deepEqual(scan.rows.map((r) => r.path).sort(), [a, b].sort());
  assert.deepEqual(scan.rows.map((r) => r.rel), ["trip/day1/photo.jpg", "trip/movie.mov"]);
  assert.ok(scan.skipped.some((s) => s.path === missing));
  const onlyFolder = tmpDir("modify-one-folder");
  makeJpeg(path.join(onlyFolder, "one.jpg"));
  const one = await call("exif.batchScan", { paths: [onlyFolder], options: { reviewAll: true, birthSupported: false } });
  assert.equal(one.single, false, "one file discovered inside a folder still uses folder navigation");
  assert.equal(one.rows.length, 1);
  const legacy = await call("exif.batchScan", { folder: root, options: { birthSupported: false } });
  assert.ok(!legacy.rows.some((r) => r.path === a), "Batch Modify retains its disagreements-only filter");
});

test("Modify saves across separate folders into one undo session without enlisting unrelated ancestors", async () => {
  const root = tmpDir("modify-session");
  const aRoot = path.join(root, "folder-a");
  const aSub = path.join(aRoot, "nested");
  const looseParent = path.join(root, "loose", "deep");
  const a = await photo(aSub, "photo.jpg", [["DateTimeOriginal", "2015:12:29 14:28:42"], ["OffsetTimeOriginal", "-05:00"]], "2022-12-24T17:24:33Z");
  const b = makeMovieAt(path.join(looseParent, "movie.mov"));
  await et.write(b, [["QuickTime:CreateDate", "2010:08:01 09:08:27Z"]]);
  setMtime(b, at("2021-01-01T00:00:00Z"));
  const directoryTime = at("2001-02-03T04:05:06Z");
  for (const dir of [aSub, aRoot, looseParent, path.dirname(looseParent), root]) setMtime(dir, directoryTime);
  const scan = await call("exif.batchScan", { paths: [aSub, aRoot, b], options: { reviewAll: true, birthSupported: false } });
  const first = await call("exif.batchApply", { scanId: scan.scanId, items: [{ path: a, decision: { set: { exif: "modified" } } }] });
  assert.equal(first.ok, 1, JSON.stringify(first.results));
  const second = await call("exif.batchApply", { scanId: scan.scanId, items: [{ path: b, decision: { set: { modified: "exif" } } }] });
  assert.equal(second.ok, 1, JSON.stringify(second.results));
  assert.equal(second.historyId, first.historyId, "navigating between selected roots keeps the same session");
  const third = await call("exif.batchApply", { scanId: scan.scanId, items: [{ path: a, decision: { tz: "Asia/Shanghai", writeTz: true, set: { modified: "exif" } } }] });
  assert.equal(third.ok, 1, JSON.stringify(third.results));
  assert.equal(third.historyId, first.historyId, "revisiting a file appends to the existing session");
  const entry = ctx.history.list().find((e) => e.id === first.historyId);
  assert.deepEqual(entry.details.paths, scan.paths);
  assert.deepEqual(entry.details.folders.map((f) => f.path).sort(), [aSub, aRoot, looseParent].sort(), "only selected folder chains and loose-file direct parents are protected");
  for (const dir of [aSub, aRoot, looseParent]) assert.equal(fs.statSync(dir).mtimeMs, directoryTime);
  const undo = await call("history.revert", { id: first.historyId });
  assert.deepEqual(undo.failures, []);
  const original = await readTags(et, a, ["DateTimeOriginal", "OffsetTimeOriginal"]);
  assert.equal(original.DateTimeOriginal, "2015:12:29 14:28:42");
  assert.equal(original.OffsetTimeOriginal, "-05:00", "the oldest metadata snapshot wins across revisits");
  assert.equal(fs.statSync(a).mtimeMs, at("2022-12-24T17:24:33Z"));
  assert.equal(fs.statSync(b).mtimeMs, at("2021-01-01T00:00:00Z"));
  for (const dir of [aSub, aRoot, looseParent]) assert.equal(fs.statSync(dir).mtimeMs, directoryTime);
});

test("Modify handles empty selections and refuses saves outside the selected files", async () => {
  await assert.rejects(call("exif.batchScan", { paths: [], options: { reviewAll: true } }), /Choose photos, videos or folders/);
  const root = tmpDir("modify-empty");
  const empty = await call("exif.batchScan", { paths: [root], options: { reviewAll: true } });
  assert.equal(empty.counts.total, 0);
  assert.deepEqual(empty.rows, []);
  const selected = makeJpeg(path.join(root, "selected.jpg"));
  const outsider = await photo(tmpDir("modify-outsider"), "outsider.jpg", [["DateTimeOriginal", "2023:05:01 12:00:00"], ["OffsetTimeOriginal", "+08:00"]], "2020-01-01T00:00:00Z");
  const scan = await call("exif.batchScan", { paths: [selected], options: { reviewAll: true } });
  await assert.rejects(call("exif.batchApply", { scanId: scan.scanId, items: [{ path: outsider, decision: { set: { modified: "exif" } } }] }), /isn't part of this scan/);
  assert.equal(fs.statSync(outsider).mtimeMs, at("2020-01-01T00:00:00Z"));
  assert.equal(ctx.recall(scan.scanId).folders.size, 0, "reject before taking any folder snapshots");
});

test("EXIF Show reports a QuickTime date as one exact UTC moment, not a stored zone", async () => {
  const file = makeMovieAt(path.join(tmpDir("show-utc"), "m.mov"));
  await et.write(file, [["QuickTime:CreateDate", "2010:08:01 09:08:27Z"]]);
  const r = await call("exif.inspect", { path: file });
  assert.equal(r.taken.utc, true);
  assert.equal(r.taken.offset, null);
  assert.equal(r.taken.text, "2010:08:01 09:08:27");
});

test("a video without a chosen zone is shown in UTC, not in this Mac's zone", () => {
  const f = file({ movie: true, absolute: true, absMs: at("2010-08-01T09:08:27Z"), storedOffsetMin: null, createdMs: at("2010-08-01T13:08:26Z"), modifiedMs: at("2010-08-01T13:08:26Z") });
  const out = batch.computeOutcome(f, { set: { created: "exif", modified: "exif" } }, OPTS);
  assert.equal(out.tz.offsetMin, 0);
  assert.equal(out.needsZone, false);
  assert.equal(tz.instantToWall(out.after.created, out.tz.spec), "2010:08:01 09:08:27");
});

test("choosing a city whose offset the file already stores changes nothing", () => {
  const f = file({ createdMs: at("2023-05-01T04:00:00Z"), modifiedMs: at("2023-05-01T04:00:00Z") });
  const same = batch.computeOutcome(f, { tz: "Asia/Shanghai", writeTz: true }, OPTS);
  assert.equal(same.writeTz, false);
  assert.equal(same.anything, false);
  assert.equal(same.sameOffset, true);
  const other = batch.computeOutcome(f, { tz: "Asia/Tokyo", writeTz: true }, OPTS);
  assert.equal(other.writeTz, true, "a different offset is a real change");
});

test("Everything follows Created previews EXIF writes, including a changed zone whose interpreted date already matches", async () => {
  const raw = file({ path: "/preview.jpg", name: "preview.jpg", createdMs: at("2023-05-01T16:00:00Z"), modifiedMs: at("2024-01-01T00:00:00Z") });
  const scanId = "created-preview";
  ctx.remember(scanId, { raws: new Map([[raw.path, raw]]), opts: OPTS });
  const preview = (decision) => call("exif.batchOutcome", { scanId, path: raw.path, decision });
  const set = { exif: "created", modified: "created" };

  const normal = await preview({ set });
  assert.equal(normal.fields.exif.changed, true);
  assert.equal(normal.fields.modified.changed, true);
  assert.equal(normal.fields.created.changed, false);
  assert.equal(normal.fields.exif.after, raw.createdMs);
  assert.equal(normal.fields.modified.after, raw.createdMs);

  const zoned = await preview({ set, tz: "America/New_York", writeTz: true });
  assert.equal(zoned.fields.exif.before, zoned.fields.exif.after, "the chosen zone makes the interpreted instant match Created");
  assert.equal(zoned.fields.exif.originalText, "2023-05-01 12:00:00 UTC+08:00");
  assert.equal(zoned.fields.exif.afterText, "2023-05-01 12:00:00 UTC-04:00");
  assert.equal(zoned.fields.exif.changed, true, "the old EXIF date must be crossed out because its stored offset will change");
  assert.equal(zoned.fields.modified.changed, true);
  assert.equal(zoned.fields.created.changed, false);
  assert.ok(zoned.writes.includes("OffsetTimeOriginal"));

  const notWriting = await preview({ set, tz: "America/New_York", writeTz: false });
  assert.equal(notWriting.fields.exif.changed, false, "a zone used only for comparison does not rewrite EXIF");
  const sameZone = await preview({ tz: "Asia/Shanghai", writeTz: true });
  assert.equal(sameZone.fields.exif.changed, false, "choosing the stored offset still leaves EXIF alone");
});

test("Created and Modified sources retain fractional seconds in photo and video EXIF writes", async () => {
  for (const movie of [false, true]) {
    const root = tmpDir("follow-source");
    const target = movie ? makeMovieAt(path.join(root, "test.mov")) : makeJpeg(path.join(root, "test.jpg"));
    await et.write(target, movie ? [["QuickTime:CreateDate", "2015:12:29 19:28:42Z"]] : [["DateTimeOriginal", "2015:12:29 14:28:42"], ["OffsetTimeOriginal", "-05:00"]]);
    const source = at("2023-05-01T16:00:00.123Z");
    for (const src of ["created", "modified"]) {
      const raw = file({ movie, createdMs: source, modifiedMs: source });
      const out = batch.computeOutcome(raw, { set: { exif: src }, tz: "America/New_York", writeTz: true }, OPTS);
      await et.write(target, batch.exifWrites(raw, out));
      const info = await require("../src/main/features/exif-copy").readInfos(ctx, [target], {});
      assert.equal(info.get(target).date.moment.ms, source, `${movie ? "video" : "photo"} follows ${src} including milliseconds`);
    }
    // Exercise the complete apply + reread + Undo path using the actual mtime.
    setMtime(target, source + 1000);
    const before = await require("../src/main/features/exif-copy").readInfos(ctx, [target], {});
    const scan = await call("exif.batchScan", { folder: target, options: { single: true } });
    const saved = await call("exif.batchApply", { scanId: scan.scanId, items: [{ path: target, decision: { set: { exif: "modified" } } }] });
    assert.equal(saved.ok, 1);
    const after = await require("../src/main/features/exif-copy").readInfos(ctx, [target], {});
    assert.equal(after.get(target).date.moment.ms, fs.statSync(target).mtimeMs);
    const undone = await call("history.revert", { id: saved.historyId });
    assert.deepEqual(undone.failures, []);
    const restored = await require("../src/main/features/exif-copy").readInfos(ctx, [target], {});
    assert.equal(restored.get(target).date.moment.ms, before.get(target).date.moment.ms);
  }
});

test("everything follows each source on disk, including Created, for photos and videos", async () => {
  const { readInfos } = require("../src/main/features/exif-copy");
  for (const movie of [false, true]) {
    for (const src of ["created", "modified", "exif"]) {
      const root = tmpDir("all-follow");
      const target = movie ? makeMovieAt(path.join(root, "test.mov")) : makeJpeg(path.join(root, "test.jpg"));
      await et.write(target, movie ? [["QuickTime:CreateDate", "2015:12:29 19:28:42Z"]] : [["DateTimeOriginal", "2015:12:29 14:28:42"], ["OffsetTimeOriginal", "-05:00"]]);
      setMtime(target, at("2022-12-24T17:24:33.123Z"));
      const st = fs.statSync(target);
      const expected = src === "created" ? st.birthtimeMs : src === "modified" ? st.mtimeMs : at("2015-12-29T19:28:42Z");
      // Linux can read Created but cannot change it. Enable it only when it is
      // the unchanged source; macOS exercises it as a target as well.
      const birthSupported = src === "created" || process.platform === "darwin";
      const scan = await call("exif.batchScan", { folder: target, options: { single: true, birthSupported } });
      const set = Object.fromEntries(["exif", "created", "modified"].filter(k => k !== src).map(k => [k, src]));
      const saved = await call("exif.batchApply", { scanId: scan.scanId, items: [{ path: target, decision: { set } }] });
      assert.equal(saved.ok, 1, JSON.stringify(saved));
      const fresh = (await readInfos(ctx, [target], {})).get(target);
      const times = fs.statSync(target);
      assert.ok(Math.abs(fresh.date.moment.ms - expected) < 1, `${movie ? "video" : "photo"} EXIF follows ${src}`);
      assert.ok(Math.abs(times.mtimeMs - expected) < 1, `Modified follows ${src}`);
      if (birthSupported) assert.ok(Math.abs(times.birthtimeMs - expected) < 1, `Created follows ${src}`);
    }
  }
});

test("file-zone previews and writes do not depend on the current Mac time zone", async () => {
  const previous = process.env.TZ;
  const snapshots = [];
  try {
    for (const hostZone of ["UTC", "America/New_York", "Asia/Shanghai"]) {
      process.env.TZ = hostZone;
      const results = [];
      for (const raw of [
        file({ path: "/photo.jpg", createdMs: at("2015-12-29T19:28:42.123Z"), modifiedMs: at("2022-12-24T17:24:33Z") }),
        file({ path: "/video.mov", movie: true, absolute: true, absMs: at("2015-12-29T19:28:42Z"), storedOffsetMin: null, createdMs: at("2015-12-29T19:28:42Z"), modifiedMs: at("2022-12-24T17:24:33Z") }),
        file({ path: "/keys.mov", movie: true, wall: "2015:12:29 14:28:42", storedOffsetMin: -300, createdMs: at("2015-12-29T19:28:42Z"), modifiedMs: at("2022-12-24T17:24:33Z") }),
      ]) {
        ctx.remember("zone-preview", { raws: new Map([[raw.path, raw]]), opts: OPTS });
        for (const src of ["exif", "created", "modified"]) {
          const decision = { set: Object.fromEntries(["exif", "created", "modified"].filter(k => k !== src).map(k => [k, src])) };
          const out = await call("exif.batchOutcome", { scanId: "zone-preview", path: raw.path, decision });
          assert.equal(new Set(Object.values(out.fields).map(f => f.afterText)).size, 1, "all final dates use one file zone and moment");
          results.push({ fields: Object.fromEntries(Object.entries(out.fields).map(([k, f]) => [k, { before: f.beforeText, after: f.afterText, original: f.originalText, changed: f.changed }])), writes: batch.exifWrites(raw, batch.computeOutcome(raw, decision, OPTS)) });
          if (raw.absolute && src === "created") assert.equal(out.fields.modified.afterText, "2015-12-29 19:28:42 UTC+00:00", "the screenshot video stays in its stored UTC zone");
        }
      }
      const unknown = batch.computeOutcome(file({ storedOffsetMin: null }), {}, OPTS);
      assert.equal(unknown.before.exif, null, "no host-zone guess for an unzoned photo");
      assert.equal(unknown.needsZone, true);
      snapshots.push(results);
    }
    assert.deepEqual(snapshots[1], snapshots[0]);
    assert.deepEqual(snapshots[2], snapshots[0]);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});


test("selection edits reuse folder membership and metadata while preserving the undo session", async (t) => {
  const root = tmpDir("incremental-folder");
  const inside = await photo(root, "nested/inside.jpg", [["DateTimeOriginal", "2023:05:01 12:00:00"], ["OffsetTimeOriginal", "+08:00"]], "2020-01-01T00:00:00Z");
  const loose = await photo(tmpDir("incremental-loose"), "loose.jpg", [["DateTimeOriginal", "2022:01:01 12:00:00"], ["OffsetTimeOriginal", "+08:00"]], "2020-01-01T00:00:00Z");
  const initial = await call("exif.batchScan", { paths: [root], options: { reviewAll: true, birthSupported: false } });
  const saved = await call("exif.batchApply", { scanId: initial.scanId, items: [{ path: inside, decision: { set: { modified: "exif" } } }] });
  const reads = [];
  const walks = [];
  const readJson = et.readJson;
  const readdir = fs.promises.readdir;
  et.readJson = function (files, ...args) { reads.push(...files); return readJson.call(this, files, ...args); };
  fs.promises.readdir = function (dir, ...args) { walks.push(dir); return readdir.call(this, dir, ...args); };
  t.after(() => { et.readJson = readJson; fs.promises.readdir = readdir; });
  const added = await call("exif.batchScan", { scanId: initial.scanId, paths: [root, loose], options: { reviewAll: true, birthSupported: false } });
  assert.deepEqual(reads, [loose], "only the new loose photo is read");
  assert.deepEqual(walks, [], "the existing folder is never traversed again");
  assert.equal(added.scanId, initial.scanId);
  assert.equal(added.historyId, saved.historyId);
  assert.deepEqual(added.savedPaths, [[inside, "saved"]]);
  reads.length = 0;
  const removed = await call("exif.batchScan", { scanId: added.scanId, paths: [root], options: { reviewAll: true, birthSupported: false } });
  assert.deepEqual(reads, [], "removing a photo reads no metadata");
  assert.deepEqual(walks, []);
  assert.deepEqual(removed.rows.map((r) => r.path), [inside]);
  const overlap = await call("exif.batchScan", { scanId: removed.scanId, paths: [root, inside], options: { reviewAll: true, birthSupported: false } });
  assert.deepEqual(reads, [], "adding an already-included loose file reuses its metadata");
  assert.equal(overlap.rows.length, 1);
  const looseOnly = await call("exif.batchScan", { scanId: overlap.scanId, paths: [inside], options: { reviewAll: true, birthSupported: false } });
  assert.deepEqual(reads, [], "removing the containing folder keeps the selected loose file cached");
  assert.deepEqual(walks, []);
  assert.equal(looseOnly.single, true);
  const undo = await call("history.revert", { id: saved.historyId });
  assert.deepEqual(undo.failures, []);
  assert.equal(fs.statSync(inside).mtimeMs, at("2020-01-01T00:00:00Z"));
  reads.length = 0;
  await call("exif.batchScan", { paths: [root], options: { reviewAll: true, birthSupported: false } });
  assert.deepEqual(reads, [inside], "an explicit fresh scan rereads the folder");
  assert.ok(walks.includes(root));
});


test("saved decisions return fresh summary counts and list row classifications", async () => {
  const file = await photo(tmpDir("fresh-summary"), "unknown.jpg", [["DateTimeOriginal", "2023:05:01 12:00:00"]], "2020-01-01T00:00:00Z");
  const scan = await call("exif.batchScan", { paths: [file], options: { reviewAll: true, birthSupported: false } });
  assert.equal(scan.counts.needsZone, 1);
  const saved = await call("exif.batchApply", { scanId: scan.scanId, items: [{ path: file, decision: { tz: "+08:00", writeTz: true, set: { modified: "exif" } } }] });
  assert.equal(saved.ok, 1);
  assert.equal(saved.counts.needsZone || 0, 0);
  assert.equal(saved.counts.agree, 1);
  assert.equal(saved.rows[0].needsZone, false);
  assert.equal(saved.rows[0].agree, true);
});

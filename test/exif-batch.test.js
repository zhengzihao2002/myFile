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

test("EXIF Show reports a QuickTime date as one exact UTC moment, not a stored zone", async () => {
  const file = makeMovieAt(path.join(tmpDir("show-utc"), "m.mov"));
  await et.write(file, [["QuickTime:CreateDate", "2010:08:01 09:08:27Z"]]);
  const r = await call("exif.inspect", { path: file });
  assert.equal(r.taken.utc, true);
  assert.equal(r.taken.offset, null);
  assert.equal(r.taken.text, "2010:08:01 09:08:27");
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeJpeg, makeMovie, tmpDir, testContext, readTags, setMtime } = require("./helpers");

const { ctx, et, call, trashed } = testContext();
test.after(() => et.close());

async function tagRef(file) {
  await et.write(file, [
    ["DateTimeOriginal", "2021:07:04 15:30:45"],
    ["CreateDate", "2021:07:04 15:30:45"],
    ["SubSecTimeOriginal", "250"],
    ["OffsetTimeOriginal", "-07:00"],
    ["GPSLatitude#", 34.0522],
    ["GPSLatitudeRef", "N"],
    ["GPSLongitude#", 118.2437],
    ["GPSLongitudeRef", "W"],
    ["GPSAltitude#", 89.5],
    ["GPSAltitudeRef#", 0],
    ["Make", "Apple"],
    ["Model", "iPhone 15 Pro"],
  ]);
}

test("inspect reports dates, GPS, camera and grouped tags", async () => {
  const dir = tmpDir("inspect");
  const ref = makeJpeg(path.join(dir, "ref.jpg"));
  await tagRef(ref);
  const info = await call("exif.inspect", { path: ref });
  assert.equal(info.kind, "image");
  assert.equal(info.taken.text, "2021:07:04 15:30:45.250 -07:00");
  assert.equal(info.taken.ms, Date.UTC(2021, 6, 4, 22, 30, 45, 250));
  assert.ok(Math.abs(info.gps.lat - 34.0522) < 1e-6);
  assert.ok(Math.abs(info.gps.lon + 118.2437) < 1e-6);
  assert.equal(info.summary.camera, "Apple iPhone 15 Pro");
  assert.equal(info.preview.type, "image");
  assert.ok(info.groups.some((g) => g.group === "ExifIFD"));
  assert.ok(info.groups[0].group === "System");
});

test("copy from a photo to a photo and a video, then undo", async () => {
  const dir = tmpDir("copy");
  const ref = makeJpeg(path.join(dir, "ref.jpg"));
  await tagRef(ref);
  const photo = makeJpeg(path.join(dir, "targets", "a.jpg"));
  const movie = makeMovie(path.join(dir, "targets", "b.mov"));
  await et.write(photo, [["DateTimeOriginal", "2000:01:01 00:00:00"]]);
  const oldMtime = Date.UTC(2010, 0, 1);
  setMtime(photo, oldMtime);

  const plan = await call("exif.copyPlan", { reference: ref, targets: [path.join(dir, "targets")] });
  assert.equal(plan.rows.length, 2);
  assert.equal(plan.reference.date, "2021:07:04 15:30:45.250 -07:00");
  const photoRow = plan.rows.find((r) => r.name === "a.jpg");
  assert.equal(photoRow.current.date, "2000:01:01 00:00:00");
  assert.equal(photoRow.changes.date, true);
  assert.equal(photoRow.changes.gps, true);

  const res = await call("exif.copyApply", { reference: ref, targets: [photo, movie] });
  assert.equal(res.ok, 2, JSON.stringify(res.results));

  const p = await readTags(et, photo, ["DateTimeOriginal", "SubSecTimeOriginal", "OffsetTimeOriginal", "GPSLatitude#", "GPSLongitudeRef"]);
  assert.equal(p.DateTimeOriginal, "2021:07:04 15:30:45");
  assert.equal(String(p.SubSecTimeOriginal), "250");
  assert.equal(p.OffsetTimeOriginal, "-07:00");
  assert.ok(Math.abs(p.GPSLatitude - 34.0522) < 1e-6);
  assert.equal(p.GPSLongitudeRef, "West");

  const [m] = await et.readJson([movie], ["-G1", "-s", "-n", "-Keys:CreationDate", "-QuickTime:CreateDate", "-Composite:GPSLatitude", "-Composite:GPSLongitude"]);
  assert.equal(m["Keys:CreationDate"], "2021:07:04 15:30:45-07:00");
  // QuickTime stores UTC; whatever zone it's shown in, it must be the same instant.
  const { parseExifDate, toMs } = require("../src/main/lib/dates");
  assert.equal(toMs(parseExifDate(m["QuickTime:CreateDate"])), Date.UTC(2021, 6, 4, 22, 30, 45));
  assert.ok(Math.abs(m["Composite:GPSLatitude"] - 34.0522) < 1e-4);
  assert.ok(Math.abs(m["Composite:GPSLongitude"] + 118.2437) < 1e-4);

  // The file's own modification date follows the reference moment.
  assert.ok(Math.abs(fs.statSync(photo).mtimeMs - Date.UTC(2021, 6, 4, 22, 30, 45, 250)) < 2);

  // Undo puts the old values back.
  const list = await call("history.list", {});
  const entry = list.find((e) => e.id === res.historyId);
  assert.ok(entry.undoable);
  await call("history.revert", { id: res.historyId });
  const back = await readTags(et, photo, ["DateTimeOriginal", "OffsetTimeOriginal", "GPSLatitude"]);
  assert.equal(back.DateTimeOriginal, "2000:01:01 00:00:00");
  assert.equal(back.OffsetTimeOriginal, undefined);
  assert.equal(back.GPSLatitude, undefined);
  assert.ok(Math.abs(fs.statSync(photo).mtimeMs - oldMtime) < 2);
  const [mBack] = await et.readJson([movie], ["-G1", "-s", "-Keys:CreationDate", "-Keys:GPSCoordinates"]);
  assert.equal(mBack["Keys:CreationDate"], undefined);
  assert.equal(mBack["Keys:GPSCoordinates"], undefined);
});

test("a video can be the reference for a photo", async () => {
  const dir = tmpDir("copy-mov");
  const ref = makeMovie(path.join(dir, "ref.mov"));
  await et.write(ref, [["Keys:CreationDate", "2019:12:31 23:59:58+09:00"], ["QuickTime:CreateDate", "2019:12:31 23:59:58+09:00"]]);
  const photo = makeJpeg(path.join(dir, "p.jpg"));
  const res = await call("exif.copyApply", { reference: ref, targets: [photo], options: { gps: true } });
  assert.equal(res.ok, 1);
  const p = await readTags(et, photo, ["DateTimeOriginal", "OffsetTimeOriginal"]);
  assert.equal(p.DateTimeOriginal, "2019:12:31 23:59:58");
  assert.equal(p.OffsetTimeOriginal, "+09:00");
});

test("set file dates from each file's own EXIF date", async () => {
  const dir = tmpDir("selfdate");
  const a = makeJpeg(path.join(dir, "a.jpg"));
  const b = makeJpeg(path.join(dir, "sub", "b.jpg"));
  makeJpeg(path.join(dir, "sub", "nodate.jpg"));
  fs.writeFileSync(path.join(dir, "notes.txt"), "not media");
  await et.write(a, [["DateTimeOriginal", "2018:05:06 07:08:09"], ["OffsetTimeOriginal", "+02:00"]]);
  await et.write(b, [["CreateDate", "2017:01:02 03:04:05"]]);

  const plan = await call("exif.datesPlan", { paths: [dir] });
  assert.equal(plan.rows.length, 3);
  assert.deepEqual(plan.counts, { change: 2, same: 0, nodate: 1 });
  const rowA = plan.rows.find((r) => r.name === "a.jpg");
  assert.equal(rowA.targetMs, Date.UTC(2018, 4, 6, 5, 8, 9));
  assert.equal(rowA.source, "Date Taken (DateTimeOriginal)");

  const res = await call("exif.datesApply", { paths: [dir] });
  assert.equal(res.changed, 2);
  assert.ok(Math.abs(fs.statSync(a).mtimeMs - Date.UTC(2018, 4, 6, 5, 8, 9)) < 2);
  // No zone: local time of this machine, like ExifTool.
  assert.ok(Math.abs(fs.statSync(b).mtimeMs - new Date(2017, 0, 2, 3, 4, 5).getTime()) < 2);

  const again = await call("exif.datesPlan", { paths: [dir] });
  assert.equal(again.counts.change, 0, "applying again finds nothing left to change");
  assert.ok(ctx.history.list().some((e) => e.id === res.historyId));
});

test("targets that already match the reference are not written, and Apply refuses when none would change", async () => {
  const dir = tmpDir("nochange");
  const ref = makeJpeg(path.join(dir, "ref.jpg"));
  await tagRef(ref);
  const twin = path.join(dir, "t", "twin.jpg");
  fs.mkdirSync(path.dirname(twin));
  fs.copyFileSync(ref, twin);
  const refMs = Date.UTC(2021, 6, 4, 22, 30, 45, 250);
  setMtime(twin, refMs);

  const plan = await call("exif.copyPlan", { reference: ref, targets: [twin], options: { fileDates: true } });
  const row = plan.rows[0];
  assert.equal(row.changes.date, false);
  assert.equal(row.changes.gps, false);
  assert.equal(row.changes.fileDates, false, "modified date already equals the reference date (created dates can't be checked off macOS)");
  assert.equal(row.willWrite, false);
  await assert.rejects(call("exif.copyApply", { reference: ref, targets: [twin], options: { fileDates: true } }), /Nothing would change/);

  // A file date that differs is a change on its own.
  setMtime(twin, refMs - 86400e3);
  const plan2 = await call("exif.copyPlan", { reference: ref, targets: [twin], options: { fileDates: true } });
  assert.equal(plan2.rows[0].changes.fileDates, true);
  assert.equal(plan2.rows[0].willWrite, true);

  // "Copy every tag": the same tags means nothing to do.
  setMtime(twin, refMs);
  const plan3 = await call("exif.copyPlan", { reference: ref, targets: [twin], options: { all: true } });
  assert.equal(plan3.rows[0].changes.all, false);
  await et.write(twin, [["Artist", "Someone else"]]);
  setMtime(twin, refMs);
  const plan4 = await call("exif.copyPlan", { reference: ref, targets: [twin], options: { all: true } });
  assert.equal(plan4.rows[0].changes.all, true);
});

test("a target whose picture was changed can be restored from the reference; the old one goes to the Trash", async () => {
  const dir = tmpDir("restore");
  const ref = makeJpeg(path.join(dir, "ref.jpg"));
  await tagRef(ref);
  const flipped = path.join(dir, "t", "flipped.jpg");
  fs.mkdirSync(path.dirname(flipped));
  fs.copyFileSync(ref, flipped);
  await et.write(flipped, [["Artist", "edited copy"]]);
  const movie = makeMovie(path.join(dir, "t", "clip.mov"));

  const plan = await call("exif.copyPlan", { reference: ref, targets: [flipped, movie] });
  assert.equal(plan.rows.find((r) => r.name === "flipped.jpg").canRestore, true);
  assert.equal(plan.rows.find((r) => r.name === "clip.mov").canRestore, false);

  const before = trashed.length;
  const res = await call("exif.copyApply", { reference: ref, targets: [flipped], options: { restore: [flipped] } });
  assert.equal(res.restored, 1, JSON.stringify(res.results));
  assert.ok(fs.readFileSync(flipped).equals(fs.readFileSync(ref)), "target is now an exact copy of the reference");
  assert.equal(trashed.length, before + 1);
  assert.equal(trashed[trashed.length - 1], flipped);
  assert.deepEqual(fs.readdirSync(path.dirname(flipped)).filter((n) => n.startsWith(".myfile-restore")), []);
});

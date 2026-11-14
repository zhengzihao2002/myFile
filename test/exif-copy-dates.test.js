"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { makeJpeg, makeMovie, tmpDir, setMtime, testContext } = require("./helpers");
const { ctx, et, task } = testContext();
test.after(() => et.close());

// Run the real copy code and ExifTool, capturing the macOS setter boundary.
// Linux cannot set birth dates, so only that native call is replaced.
function macCopy(captured) {
  const filename = require.resolve("../src/main/features/exif-copy");
  const realTimes = require("../src/main/lib/filetimes");
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const realRequire = mod.require.bind(mod);
  mod.require = (name) => name === "../lib/filetimes" ? {
    ...realTimes,
    canSetBirthtime: () => true,
    async applyTimes(entries) {
      captured.push(...entries);
      return realTimes.applyTimes(entries.map(({ birthMs, ...entry }) => entry));
    },
  } : realRequire(name);
  mod._compile(fs.readFileSync(filename, "utf8"), filename);
  return mod.exports;
}

async function setup(movie) {
  const root = tmpDir("copy-dates");
  const reference = makeJpeg(path.join(root, "reference.jpg"));
  const target = movie ? makeMovie(path.join(root, "target.mov")) : makeJpeg(path.join(root, "target.jpg"));
  await et.write(reference, [["DateTimeOriginal", "2023:05:01 12:00:00"], ["OffsetTimeOriginal", "+08:00"], ["SubSecTimeOriginal", "123"]]);
  await et.write(target, movie ? [["Keys:CreationDate", "2010:01:02 03:04:05+08:00"]] : [["DateTimeOriginal", "2010:01:02 03:04:05"], ["OffsetTimeOriginal", "+08:00"]]);
  setMtime(target, Date.parse("2014-02-03T04:05:06Z"));
  return { reference, target, before: fs.statSync(target), source: Date.parse("2023-05-01T04:00:00.123Z") };
}

test("Created and Modified have independent previews and independent setter values", async () => {
  for (const movie of [false, true]) {
    for (const [created, modified] of [[true,false],[false,true],[true,true],[false,false]]) {
      const { reference, target, before, source } = await setup(movie);
      const captured = [];
      const copy = macCopy(captured);
      const options = { date: true, gps: false, created, modified };
      const plan = await copy.copyPlan(ctx, { reference, targets: [target], options }, task);
      const row = plan.rows[0];
      assert.equal(row.changes.created, created);
      assert.equal(row.changes.modified, modified);
      assert.equal(row.next.createdMs, created ? source : null);
      assert.equal(row.next.modifiedMs, modified ? source : null);
      const result = await copy.copyApply(ctx, { reference, targets: [target], options }, task);
      assert.equal(result.ok, 1, JSON.stringify(result));
      assert.equal(captured.length, 1);
      assert.equal(captured[0].birthMs, created ? source : before.birthtimeMs, "unchecked Created is explicitly restored after Modified/metadata writes");
      assert.equal(captured[0].mtimeMs, modified ? source : before.mtimeMs, "unchecked Modified keeps the original value");
      assert.ok(Math.abs(fs.statSync(target).mtimeMs - (modified ? source : before.mtimeMs)) < 1);
      const undo = ctx.history.getUndo(result.historyId);
      assert.equal(undo.times[0].birthMs, before.birthtimeMs);
      assert.equal(undo.times[0].mtimeMs, before.mtimeMs);
    }
  }
});

test("explicit date selections override the old combined option", async () => {
  const { reference, target, source } = await setup(false);
  const copy = macCopy([]);
  const plan = await copy.copyPlan(ctx, { reference, targets: [target], options: { fileDates: true, created: false, modified: true } }, task);
  assert.equal(plan.rows[0].changes.created, false);
  assert.equal(plan.rows[0].next.createdMs, null);
  assert.equal(plan.rows[0].next.modifiedMs, source);
});

test("all metadata leaves both unchecked file dates alone", async () => {
  const { reference, target, before } = await setup(false);
  const captured = [];
  const result = await macCopy(captured).copyApply(ctx, { reference, targets: [target], options: { all: true, created: false, modified: false } }, task);
  assert.equal(result.ok, 1);
  assert.equal(captured[0].birthMs, before.birthtimeMs);
  assert.equal(captured[0].mtimeMs, before.mtimeMs);
  assert.equal(fs.statSync(target).mtimeMs, before.mtimeMs);
});

test("picture replacement preserves unchecked target dates rather than inheriting reference file dates", async () => {
  const { reference, target, before } = await setup(false);
  const captured = [];
  const result = await macCopy(captured).copyApply(ctx, { reference, targets: [target], options: { restore: [target], created: false, modified: false } }, task);
  assert.equal(result.restored, 1);
  assert.equal(captured[0].birthMs, before.birthtimeMs);
  assert.equal(captured[0].mtimeMs, before.mtimeMs);
  assert.equal(fs.statSync(target).mtimeMs, before.mtimeMs);
});

test("file-date-only operations do not write EXIF and are recoverable from History", async () => {
  for (const [created, modified] of [[true,false],[false,true]]) {
    const { reference, target, before, source } = await setup(false);
    const bytes = fs.readFileSync(target);
    const captured = [];
    const result = await macCopy(captured).copyApply(ctx, { reference, targets: [target], options: { date: false, gps: false, camera: false, created, modified } }, task);
    assert.equal(result.ok, 1, JSON.stringify(result));
    assert.deepEqual(fs.readFileSync(target), bytes, "only file-system dates change");
    assert.equal(captured[0].birthMs, created ? source : before.birthtimeMs);
    assert.equal(captured[0].mtimeMs, modified ? source : before.mtimeMs);
    assert.equal(result.undoable, true);
    assert.deepEqual(ctx.history.getUndo(result.historyId).exif, []);
    const { call } = testContext();
    const undone = await call("history.revert", { id: result.historyId });
    assert.equal(undone.pending, 0);
    assert.equal(fs.statSync(target).mtimeMs, before.mtimeMs);
  }
});

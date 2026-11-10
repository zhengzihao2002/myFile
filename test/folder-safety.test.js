"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTree, tmpDir, testContext, setMtime, readTags } = require("./helpers");

const { ctx, et, call, handlers } = testContext();
test.after(() => et.close());

const REFERENCE_TIME = Date.UTC(2014, 2, 4, 5, 6, 7);
const TARGET_TIME = Date.UTC(2021, 5, 6, 7, 8, 9);
const CHANGED_TIME = Date.UTC(2024, 7, 8, 9, 10, 11);
const OPTIONS = { created: false, modified: true, exif: true };
const STALE = /changed|check again|out of date/i;

async function fixture({ photos = true } = {}) {
  const spec = photos ? { "nested/a.jpg": "jpeg", "notes.txt": "original" } : { "nested/a.txt": "original", "notes.txt": "original" };
  const reference = makeTree(tmpDir("safe-ref"), spec);
  const target = makeTree(tmpDir("safe-target"), spec);
  if (photos) {
    await et.write(path.join(reference, "nested/a.jpg"), [["DateTimeOriginal", "2014:03:04 05:06:07"], ["OffsetTimeOriginal", "+08:00"]]);
    await et.write(path.join(target, "nested/a.jpg"), [["DateTimeOriginal", "2021:06:06 07:08:09"], ["OffsetTimeOriginal", "-05:00"]]);
  }
  for (const [root, time] of [[reference, REFERENCE_TIME], [target, TARGET_TIME]]) {
    for (const rel of [photos ? "nested/a.jpg" : "nested/a.txt", "notes.txt", "nested", ""]) setMtime(path.join(root, rel), time);
  }
  const plan = await call("folder.modifyPlan", { reference, targets: [target], options: OPTIONS });
  assert.equal(plan.targets[0].status, "match");
  return { reference, target, plan };
}

for (const change of ["structure", "date", "EXIF", "same-size contents"]) {
  test(`Folder Modify refuses a target whose ${change} changed after Check`, async () => {
    const { target, plan } = await fixture();
    const image = path.join(target, "nested/a.jpg");
    if (change === "structure") fs.writeFileSync(path.join(target, "added.txt"), "new item");
    if (change === "date") setMtime(path.join(target, "notes.txt"), CHANGED_TIME);
    if (change === "EXIF") {
      await et.write(image, [["DateTimeOriginal", "2024:08:08 09:10:11"]]);
      setMtime(image, TARGET_TIME);
    }
    if (change === "same-size contents") {
      fs.writeFileSync(path.join(target, "notes.txt"), "changed!");
      setMtime(path.join(target, "notes.txt"), TARGET_TIME);
    }
    const before = fs.readFileSync(image);
    const beforeNote = fs.readFileSync(path.join(target, "notes.txt"));
    const beforeNoteTime = fs.statSync(path.join(target, "notes.txt")).mtimeMs;
    const historyCount = ctx.history.list().length;
    await assert.rejects(call("folder.modifyApply", { planId: plan.id }), STALE);
    assert.deepEqual(fs.readFileSync(image), before, "refusing a stale plan must not change metadata");
    assert.deepEqual(fs.readFileSync(path.join(target, "notes.txt")), beforeNote);
    assert.equal(fs.statSync(path.join(target, "notes.txt")).mtimeMs, beforeNoteTime);
    assert.equal(ctx.history.list().length, historyCount, "no recovery entry is needed when no write begins");
  });
}

for (const change of ["date", "EXIF"]) {
  test(`Folder Modify refuses a reference whose ${change} changed after Check`, async () => {
    const { reference, target, plan } = await fixture();
    if (change === "date") setMtime(path.join(reference, "notes.txt"), CHANGED_TIME);
    else {
      await et.write(path.join(reference, "nested/a.jpg"), [["DateTimeOriginal", "2024:08:08 09:10:11"]]);
      setMtime(path.join(reference, "nested/a.jpg"), REFERENCE_TIME);
    }
    const image = path.join(target, "nested/a.jpg");
    const before = fs.readFileSync(image);
    await assert.rejects(call("folder.modifyApply", { planId: plan.id }), STALE);
    assert.deepEqual(fs.readFileSync(image), before);
    assert.equal(fs.statSync(path.join(target, "notes.txt")).mtimeMs, TARGET_TIME);
  });
}

test("Folder Modify refuses a changed HTML reference", async () => {
  const { reference, target } = await fixture({ photos: false });
  const html = path.join(tmpDir("safe-html"), "reference.html");
  await call("folder.index", { folder: reference, output: html, options: { exif: false } });
  const plan = await call("folder.modifyPlan", { reference: html, targets: [target], options: { ...OPTIONS, exif: false } });
  setMtime(path.join(reference, "notes.txt"), CHANGED_TIME);
  await call("folder.index", { folder: reference, output: html, options: { exif: false } });
  await assert.rejects(call("folder.modifyApply", { planId: plan.id }), STALE);
  assert.equal(fs.statSync(path.join(target, "notes.txt")).mtimeMs, TARGET_TIME);
});

test("Folder Modify preflights every chosen target before changing the first", async () => {
  const { reference, target: first } = await fixture({ photos: false });
  const second = makeTree(tmpDir("safe-second"), { "nested/a.txt": "original", "notes.txt": "original" });
  for (const rel of ["nested/a.txt", "notes.txt", "nested", ""]) setMtime(path.join(second, rel), TARGET_TIME);
  const plan = await call("folder.modifyPlan", { reference, targets: [first, second], options: { ...OPTIONS, exif: false } });
  setMtime(path.join(second, "notes.txt"), CHANGED_TIME);
  await assert.rejects(call("folder.modifyApply", { planId: plan.id }), STALE);
  assert.equal(fs.statSync(path.join(first, "notes.txt")).mtimeMs, TARGET_TIME, "the first target is unchanged when a later target fails validation");
});

test("Folder Modify saves current undo snapshots and restores EXIF, file dates and folder dates", async () => {
  const { target, plan } = await fixture();
  const result = await call("folder.modifyApply", { planId: plan.id });
  assert.equal(result.targets[0].exifWritten, 1);
  assert.equal((await readTags(et, path.join(target, "nested/a.jpg"), ["DateTimeOriginal"])).DateTimeOriginal, "2014:03:04 05:06:07");
  const undo = await call("history.revert", { id: result.historyId });
  assert.deepEqual(undo.failures, []);
  assert.equal((await readTags(et, path.join(target, "nested/a.jpg"), ["DateTimeOriginal"])).DateTimeOriginal, "2021:06:06 07:08:09");
  for (const rel of ["nested/a.jpg", "notes.txt", "nested", ""]) assert.equal(fs.statSync(path.join(target, rel)).mtimeMs, TARGET_TIME, `${rel || "root"} retains its pre-write date after Undo`);
});

test("cancelling Folder Modify after an EXIF write preserves recovery data and folder dates", async (t) => {
  const { reference, target } = await fixture();
  const plan = await call("folder.modifyPlan", { reference, targets: [target], options: { created: false, modified: false, exif: true } });
  const previousIds = new Set(ctx.history.list().map((entry) => entry.id));
  const controller = new AbortController();
  const original = et.write;
  let wrote = false;
  et.write = async function (file, ...args) {
    if (!wrote && file.startsWith(target + path.sep)) {
      const journal = ctx.history.list().find((item) => !previousIds.has(item.id));
      assert.ok(journal && journal.undoable, "recovery is durable before the first metadata mutation starts");
      const snapshots = ctx.history.getUndo(journal.id);
      assert.ok(snapshots.exif.some((item) => item.path === file), "the pre-write journal includes this file's metadata");
      assert.ok(snapshots.times.some((item) => item.path === file), "the pre-write journal includes this file's dates");
    }
    const result = await original.call(this, file, ...args);
    if (!wrote && file.startsWith(target + path.sep)) { wrote = true; controller.abort(); }
    return result;
  };
  t.after(() => { et.write = original; });
  const cancelled = await handlers["folder.modifyApply"]({ planId: plan.id }, { signal: controller.signal, progress: () => {} });
  assert.equal(cancelled.cancelled, true, "completed changes are returned with a cancellation outcome");
  assert.equal(wrote, true);
  const entry = ctx.history.list().find((item) => !previousIds.has(item.id));
  assert.ok(entry && entry.undoable, "the completed or partially completed write remains undoable");
  assert.equal(cancelled.historyId, entry.id);
  for (const rel of ["nested", ""]) assert.equal(fs.statSync(path.join(target, rel)).mtimeMs, TARGET_TIME, "cancellation must not leave metadata-write folder dates changed");
  et.write = original;
  const undo = await call("history.revert", { id: entry.id });
  assert.deepEqual(undo.failures, []);
  assert.equal((await readTags(et, path.join(target, "nested/a.jpg"), ["DateTimeOriginal"])).DateTimeOriginal, "2021:06:06 07:08:09");
});

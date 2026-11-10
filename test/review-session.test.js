"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const session = require("../src/main/features/review-session");
const { tmpDir, testContext, makeJpeg, setMtime } = require("./helpers");

function fakeContext(dir = tmpDir("review-state")) {
  const scans = new Map();
  const entries = [];
  return { runtime: { dataDir: dir }, scans, entries, recall: (id) => scans.get(id), history: { list: () => entries } };
}
const raw = (modifiedMs = 1000) => ({ wall: "2023:05:01 12:00:00", subsec: "123", storedOffsetMin: 480, createdMs: 1000, modifiedMs });

test("review drafts persist decisions, queue position and filters without caching metadata", () => {
  const ctx = fakeContext();
  const file = path.join(ctx.runtime.dataDir, "photo.jpg");
  const scan = { paths: [file], raws: new Map([[file, raw()]]), folders: new Map(), savedPaths: new Map(), historyId: null };
  ctx.scans.set("scan", scan);
  const state = { decisions: [[file, { choice: "all-modified", tz: "Asia/Shanghai", writeTz: true }]], status: [[file, "skipped"]], current: file, tab: "skipped", filter: "photos", search: "photo", useGps: false };
  assert.deepEqual(session.save(ctx, { scanId: "scan", state }), { saved: true });
  const restarted = fakeContext(ctx.runtime.dataDir);
  const draft = session.load(restarted);
  assert.deepEqual(draft.paths, [file]);
  assert.deepEqual(draft.state, state);
  assert.equal(draft.raws, undefined, "file data is read on resume, never restored from a stale cache");
  assert.deepEqual(session.restore(restarted, { raws: new Map([[file, raw()]]), folders: new Map() }), state);
  session.clear(restarted);
  assert.equal(session.load(ctx), null);
});

test("resuming keeps saved status only for unchanged existing files and unreverted history", () => {
  const ctx = fakeContext();
  const unchanged = path.join(ctx.runtime.dataDir, "unchanged.jpg");
  const changed = path.join(ctx.runtime.dataDir, "changed.jpg");
  const gone = path.join(ctx.runtime.dataDir, "gone.jpg");
  const folder = { path: ctx.runtime.dataDir, mtimeMs: 500, atimeMs: 400 };
  const scan = { paths: [ctx.runtime.dataDir], raws: new Map([unchanged, changed, gone].map((p) => [p, raw()])), historyId: "history", folders: new Map([[ctx.runtime.dataDir, folder]]), savedPaths: new Map([[unchanged, "saved"], [changed, "saved"]]) };
  ctx.scans.set("scan", scan);
  ctx.entries.push({ id: "history", reverted: false });
  session.save(ctx, { scanId: "scan", state: { status: [[unchanged, "saved"], [changed, "saved"], [gone, "skipped"]], decisions: [] } });
  const fresh = { raws: new Map([[unchanged, raw()], [changed, raw(2000)]]), folders: new Map(), historyId: null, savedPaths: new Map() };
  assert.deepEqual(session.restore(ctx, fresh).status, [[unchanged, "saved"]]);
  assert.equal(fresh.historyId, "history");
  assert.deepEqual([...fresh.folders], [[ctx.runtime.dataDir, folder]]);
  assert.ok(!fresh.savedPaths.has(changed), "externally changed files return to review");
  ctx.entries[0].reverted = true;
  const undone = { raws: fresh.raws, folders: new Map(), historyId: null, savedPaths: new Map() };
  session.restore(ctx, undone);
  assert.equal(undone.historyId, null, "reverted history is never reattached to a new write session");
});

test("a review draft never attaches choices or undo history to an unrelated selection", () => {
  const ctx = fakeContext();
  const file = path.join(ctx.runtime.dataDir, "photo.jpg");
  const unrelated = path.join(ctx.runtime.dataDir, "another-folder");
  const scan = { paths: [file], raws: new Map([[file, raw()]]), folders: new Map([[ctx.runtime.dataDir, { mtimeMs: 10 }]]), historyId: "old-history", savedPaths: new Map([[file, "saved"]]) };
  ctx.scans.set("old", scan);
  ctx.entries.push({ id: "old-history", reverted: false });
  session.save(ctx, { scanId: "old", state: { decisions: [[file, { choice: "all-modified" }]], status: [[file, "saved"]], filter: "videos", search: "old", tab: "saved" } });
  const fresh = { paths: [unrelated], raws: new Map([[file, raw()]]), folders: new Map(), historyId: null, savedPaths: new Map() };
  assert.equal(session.restore(ctx, fresh), null, "matching cached metadata alone cannot authorize restoring another source's draft");
  assert.equal(fresh.historyId, null);
  assert.deepEqual([...fresh.folders], []);
  assert.deepEqual([...fresh.savedPaths], []);
  assert.equal(session.restore(ctx, { ...fresh, paths: [] }), null, "an empty resumed selection must not consume a pending draft");
});

test("invalid and expired review drafts are rejected safely", () => {
  const ctx = fakeContext();
  assert.throws(() => session.save(ctx, { scanId: "missing", state: {} }), /out of date/);
  const file = path.join(ctx.runtime.dataDir, "date-review.json");
  fs.writeFileSync(file, JSON.stringify({ version: 2, paths: ["/photo.jpg"] }));
  assert.equal(session.load(ctx), null);
  fs.writeFileSync(file, JSON.stringify({ version: 1, paths: ["relative/photo.jpg"] }));
  assert.equal(session.load(ctx), null);
  fs.writeFileSync(file, "invalid-json");
  assert.equal(session.load(ctx), null);
});

test("the real review handlers resume with fresh metadata after the file changes", async (t) => {
  const { ctx, et, call } = testContext();
  t.after(() => { session.clear(ctx); et.close(); });
  const file = makeJpeg(path.join(tmpDir("review-resume"), "photo.jpg"));
  await et.write(file, [["DateTimeOriginal", "2023:05:01 12:00:00"], ["OffsetTimeOriginal", "+08:00"]]);
  setMtime(file, Date.parse("2024-01-01T00:00:00Z"));
  const first = await call("exif.batchScan", { paths: [file], options: { reviewAll: true } });
  const state = { decisions: [[file, { choice: "all-modified", tz: "", writeTz: false }]], status: [[file, "skipped"]], current: file, tab: "todo", filter: "all", search: "" };
  await call("exif.reviewSave", { scanId: first.scanId, state });
  assert.deepEqual((await call("exif.reviewLoad")).state, state);
  setMtime(file, Date.parse("2025-01-01T00:00:00Z"));
  const resumed = await call("exif.batchScan", { paths: [file], resume: true, options: { reviewAll: true } });
  assert.notEqual(resumed.scanId, first.scanId);
  assert.equal(resumed.rows[0].modifiedMs, Date.parse("2025-01-01T00:00:00Z"));
  assert.deepEqual(resumed.restoredState.status, [], "the changed file is no longer treated as already skipped");
  assert.deepEqual(resumed.restoredState.decisions, state.decisions, "the user's unsaved choice can be reviewed against fresh dates");
  await call("exif.reviewClear");
  assert.equal(await call("exif.reviewLoad"), null);
});

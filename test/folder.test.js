"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTree, tmpDir, testContext, setMtime, readTags } = require("./helpers");
const { parseIndexHtml, indexToItems } = require("../src/main/features/folder-index");

const { et, call } = testContext();
test.after(() => et.close());

const T1 = Date.UTC(2020, 0, 2, 3, 4, 5, 500);
const T2 = Date.UTC(2022, 5, 6, 7, 8, 9);

test("compare finds only-in-A, only-in-B, changed, identical and date differences", async () => {
  const a = makeTree(tmpDir("cmpA"), {
    "same.txt": "hello",
    "samesize.txt": "abcde",
    "bigger.txt": "1",
    "onlyA.txt": "x",
    "dirA/": null,
    "nested/deep/file.txt": "deep",
    ".DS_Store": "junk",
  });
  const b = makeTree(tmpDir("cmpB"), {
    "same.txt": "hello",
    "samesize.txt": "abcdX",
    "bigger.txt": "12",
    "onlyB.txt": "y",
    "nested/deep/file.txt": "deep",
  });
  setMtime(path.join(a, "same.txt"), T1);
  setMtime(path.join(b, "same.txt"), T2);
  setMtime(path.join(a, "samesize.txt"), T1);
  setMtime(path.join(b, "samesize.txt"), T2);

  const r = await call("folder.compare", { a, b });
  assert.deepEqual(r.onlyA.map((x) => x.rel), ["onlyA.txt"]);
  assert.deepEqual(r.onlyB.map((x) => x.rel), ["onlyB.txt"]);
  assert.deepEqual(r.foldersOnlyA, ["dirA"]);
  const changed = Object.fromEntries(r.changed.map((x) => [x.rel, x.reason]));
  assert.deepEqual(changed, { "bigger.txt": "size", "samesize.txt": "content" });
  const same = r.identical.find((x) => x.rel === "same.txt");
  assert.equal(same.check, "bytes");
  assert.equal(same.diff, "modified");
  assert.ok(r.dateDiffs.some((x) => x.rel === "same.txt"));
  assert.equal(r.a.skipped, 1, ".DS_Store is skipped by default");
  assert.equal(r.same, false);

  const out = path.join(tmpDir("report"), "report.html");
  const exp = await call("folder.compareExport", { id: r.id, output: out });
  const html = fs.readFileSync(out, "utf8");
  assert.ok(exp.bytes > 1000);
  assert.ok(html.includes('id="myfile-compare"'));
  assert.ok(!html.includes("__DATA__"));
});

test("generate HTML index, then read it back", async () => {
  const root = makeTree(tmpDir("idx"), { "Photos/a.jpg": "jpeg", "Photos/b.mov": "mov", "doc.txt": "text", "empty/": null });
  await et.write(path.join(root, "Photos", "a.jpg"), [["DateTimeOriginal", "2015:03:04 05:06:07"], ["OffsetTimeOriginal", "+01:00"]]);
  await et.write(path.join(root, "Photos", "b.mov"), [["Keys:CreationDate", "2016:01:01 10:00:00-05:00"]]);
  setMtime(path.join(root, "doc.txt"), T1);
  const out = path.join(tmpDir("idx-out"), "index.html");
  const res = await call("folder.index", { folder: root, output: out, options: { exif: true } });
  assert.equal(res.stats.files, 3);
  assert.equal(res.stats.withExif, 2);
  assert.equal(res.insideFolder, false);

  const index = parseIndexHtml(fs.readFileSync(out, "utf8"));
  assert.equal(index.kind, "myfile");
  const items = indexToItems(index);
  assert.equal(items.get("doc.txt").mtimeMs, T1);
  assert.equal(items.get("Photos/a.jpg").exif["ExifIFD:DateTimeOriginal"], "2015:03:04 05:06:07");
  assert.equal(items.get("Photos/a.jpg").exif["ExifIFD:OffsetTimeOriginal"], "+01:00");
  assert.equal(items.get("Photos/b.mov").exif["Keys:CreationDate"], "2016:01:01 10:00:00-05:00");
  assert.equal(items.get("empty").kind, "dir");

  const info = await call("folder.indexInfo", { path: out });
  assert.equal(info.hasExif, true);
  assert.equal(info.name, path.basename(root));
});

test("reads the file_directory.html made by the original main.py", async () => {
  const html = fs.readFileSync(path.join(__dirname, "fixtures", "legacy-file-directory.html"), "utf8");
  const index = parseIndexHtml(html);
  assert.equal(index.kind, "legacy");
  const items = indexToItems(index);
  assert.ok(items.has("Day 1/notes.txt"));
  assert.equal(items.get("Day 1/notes.txt").kind, "file");
  assert.equal(items.get("readme.md").size, 3);
  assert.ok(Number.isFinite(items.get("readme.md").mtimeMs));
});

test("modify fixes dates and EXIF in matching targets, refuses mismatched ones, and undoes", async () => {
  const ref = makeTree(tmpDir("modRef"), { "p/a.jpg": "jpeg", "p/b.txt": "bee", "c.txt": "see" });
  await et.write(path.join(ref, "p", "a.jpg"), [["DateTimeOriginal", "2011:11:11 11:11:11"]]);
  const good = makeTree(tmpDir("modGood"), { "p/a.jpg": "jpeg", "p/b.txt": "bee", "c.txt": "see" });
  await et.write(path.join(good, "p", "a.jpg"), [["DateTimeOriginal", "1999:09:09 09:09:09"]]);
  const bad = makeTree(tmpDir("modBad"), { "p/a.jpg": "jpeg", "p/other.txt": "bee", "c.txt": "see" });

  for (const rel of ["p/a.jpg", "p/b.txt", "c.txt", "p", ""]) setMtime(path.join(ref, rel), T1);
  for (const rel of ["p/a.jpg", "p/b.txt", "c.txt", "p", ""]) setMtime(path.join(good, rel), T2);

  const plan = await call("folder.modifyPlan", { reference: ref, targets: [good, bad] });
  const [g, b] = plan.targets;
  assert.equal(b.status, "mismatch");
  assert.deepEqual(b.problems.missing, ["p/b.txt"]);
  assert.deepEqual(b.problems.extra, ["p/other.txt"]);
  assert.equal(g.status, "match");
  assert.equal(g.summary.modified, 5, "root, folder and three files");
  assert.equal(g.summary.exif, 1);

  const res = await call("folder.modifyApply", { planId: plan.id });
  assert.equal(res.targets.length, 1);
  assert.equal(res.targets[0].exifWritten, 1);
  assert.equal(res.targets[0].remaining, 0, "verification finds nothing left to fix");
  for (const rel of ["p/a.jpg", "p/b.txt", "c.txt", "p", ""]) {
    assert.ok(Math.abs(fs.statSync(path.join(good, rel)).mtimeMs - T1) < 2, `${rel || "."} modified date`);
  }
  const t = await readTags(et, path.join(good, "p", "a.jpg"), ["DateTimeOriginal"]);
  assert.equal(t.DateTimeOriginal, "2011:11:11 11:11:11");

  await call("history.revert", { id: res.historyId });
  const back = await readTags(et, path.join(good, "p", "a.jpg"), ["DateTimeOriginal"]);
  assert.equal(back.DateTimeOriginal, "1999:09:09 09:09:09");
  assert.ok(Math.abs(fs.statSync(path.join(good, "c.txt")).mtimeMs - T2) < 2);
});

test("modify can use an HTML index as the reference", async () => {
  const ref = makeTree(tmpDir("htmlRef"), { "x/y.txt": "why", "z.txt": "zed" });
  for (const rel of ["x/y.txt", "z.txt", "x", ""]) setMtime(path.join(ref, rel), T1);
  const out = path.join(tmpDir("htmlOut"), "ref.html");
  await call("folder.index", { folder: ref, output: out, options: { exif: false } });
  const target = makeTree(tmpDir("htmlTarget"), { "x/y.txt": "why", "z.txt": "zed" });
  const plan = await call("folder.modifyPlan", { reference: out, targets: [target] });
  assert.equal(plan.reference.kind, "html");
  assert.equal(plan.targets[0].status, "match");
  await call("folder.modifyApply", { planId: plan.id });
  assert.ok(Math.abs(fs.statSync(path.join(target, "x", "y.txt")).mtimeMs - T1) < 2);
  assert.ok(Math.abs(fs.statSync(target).mtimeMs - T1) < 2);
});

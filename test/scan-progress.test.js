"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { readInfos } = require("../src/main/features/exif-copy");
const { CancelledError } = require("../src/main/lib/util");
const { makeJpeg, tmpDir, testContext } = require("./helpers");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("granular progress completes one file at a time and names only bounded in-flight files", async () => {
  const files = ["/media/a.jpg", "/media/b.jpg", "/media/c.jpg", "/media/d.jpg"];
  const reads = [];
  const progress = [];
  const ctx = {
    settings: { get: () => ({ parallelFiles: 8 }) },
    et: {
      procs: [{}, {}],
      readJson(chunk) {
        assert.equal(chunk.length, 1);
        const gate = deferred();
        reads.push({ file: chunk[0], gate });
        return gate.promise;
      },
    },
  };
  const job = readInfos(ctx, files, { granular: true, volumes: [{ solidState: true }], onProgress: (p) => progress.push(p) });
  assert.deepEqual(reads.map((r) => r.file), files.slice(0, 2), "queued files beyond the ET pool have not started");
  assert.deepEqual(progress.at(-1).active, ["a.jpg", "b.jpg"]);
  assert.ok(!progress.some((p) => p.active.includes("c.jpg")));
  reads[0].gate.resolve([{ SourceFile: files[0] }]);
  await tick();
  assert.deepEqual(reads.map((r) => r.file), files.slice(0, 3));
  assert.deepEqual(progress.at(-1).active, ["b.jpg", "c.jpg"]);
  assert.equal(progress.at(-1).done, 1);
  reads[1].gate.resolve([{ SourceFile: files[1] }]);
  await tick();
  assert.equal(progress.at(-1).done, 2);
  assert.deepEqual(progress.at(-1).active, ["c.jpg", "d.jpg"]);
  reads[2].gate.resolve([{ SourceFile: files[2] }]);
  reads[3].gate.resolve([{ SourceFile: files[3] }]);
  const infos = await job;
  assert.equal(infos.size, 4);
  assert.equal(progress.at(-1).done, 4);
  assert.deepEqual(progress.at(-1).active, []);
  assert.ok(progress.every((p) => p.active.length <= 2));
  assert.ok(progress.every((p, i) => !i || p.done >= progress[i - 1].done));
});

test("granular progress honors a spinning disk and the explicit concurrency setting", async () => {
  for (const [setting, volumes] of [["auto", [{ solidState: false }]], [1, [{ solidState: true }]]]) {
    let inFlight = 0;
    let peak = 0;
    const ctx = {
      settings: { get: () => ({ parallelFiles: setting }) },
      et: { procs: [{}, {}, {}, {}], async readJson([file]) {
        peak = Math.max(peak, ++inFlight);
        await tick();
        inFlight--;
        return [{ SourceFile: file }];
      } },
    };
    await readInfos(ctx, ["/media/a.jpg", "/media/b.jpg", "/media/c.jpg"], { granular: true, volumes });
    assert.equal(peak, 1, `${setting} with ${JSON.stringify(volumes)}`);
  }
});

test("granular reads report failed files and continue, while cancellation settles active workers", async () => {
  const failures = [];
  const progress = [];
  const ctx = {
    settings: { get: () => ({ parallelFiles: 1 }) },
    et: { procs: [{}], async readJson([file]) {
      if (file.endsWith("bad.jpg")) throw new Error("Permission denied");
      return [{ SourceFile: file }];
    } },
  };
  const infos = await readInfos(ctx, ["/media/bad.jpg", "/media/good.jpg"], { granular: true, onError: (file, err) => failures.push({ file, error: err.message }), onProgress: (p) => progress.push(p) });
  assert.deepEqual([...infos.keys()], ["/media/good.jpg"]);
  assert.deepEqual(failures, [{ file: "/media/bad.jpg", error: "Permission denied" }]);
  assert.equal(progress.at(-1).done, 2);
  const controller = new AbortController();
  const gates = [];
  ctx.settings.get = () => ({ parallelFiles: 2 });
  ctx.et.procs = [{}, {}];
  ctx.et.readJson = () => { const gate = deferred(); gates.push(gate); return gate.promise; };
  const job = readInfos(ctx, ["/media/a.jpg", "/media/b.jpg", "/media/c.jpg"], { granular: true, signal: controller.signal, onError: () => assert.fail("cancellation is not an unreadable-file warning") });
  let settled = false;
  const rejection = assert.rejects(job, { code: "CANCELLED" }).then(() => { settled = true; });
  controller.abort();
  gates[0].reject(new CancelledError());
  await tick();
  assert.equal(settled, false, "the second active worker is still awaited");
  gates[1].reject(new CancelledError());
  await rejection;
  assert.equal(gates.length, 2, "no queued third file starts after cancellation");
});

test("ExifTool error records and missing records are skipped rather than becoming undated photos", async () => {
  const failures = [];
  const ctx = {
    settings: { get: () => ({ parallelFiles: 1 }) },
    et: { procs: [{}], async readJson([file]) {
      return file.endsWith("error.jpg") ? [{ SourceFile: file, "ExifTool:Error": "File could not be read" }] : [];
    } },
  };
  const out = await readInfos(ctx, ["/media/error.jpg", "/media/missing.jpg"], { granular: true, onError: (file, err) => failures.push({ file, message: err.message }) });
  assert.equal(out.size, 0);
  assert.deepEqual(failures, [
    { file: "/media/error.jpg", message: "File could not be read" },
    { file: "/media/missing.jpg", message: "ExifTool returned no metadata for this file." },
  ]);
});

test("granular reads preserve real ExifTool metadata and finish with an empty active list", async (t) => {
  const { ctx, et } = testContext();
  t.after(() => et.close());
  const root = tmpDir("granular-metadata");
  const files = ["a.jpg", "b.jpg", "c.jpg"].map((name) => makeJpeg(path.join(root, name)));
  await et.write(files[0], [["DateTimeOriginal", "2023:05:01 12:00:00"], ["OffsetTimeOriginal", "+08:00"]]);
  const progress = [];
  const infos = await readInfos(ctx, files, { granular: true, volumes: [{ solidState: true }], onProgress: (p) => progress.push(p) });
  assert.equal(infos.get(files[0]).date.moment.wall, "2023:05:01 12:00:00");
  assert.equal(infos.get(files[0]).date.moment.offset, "+08:00");
  assert.equal(infos.size, 3);
  assert.equal(progress.at(-1).done, 3);
  assert.deepEqual(progress.at(-1).active, []);
  assert.ok(progress.some((p) => p.done === 1), "completion is visible before a whole batch finishes");
});

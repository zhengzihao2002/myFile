"use strict";

// Folder › Compare: what's only in A, only in B, changed, identical, and
// which identical items have different dates. Exportable as an HTML report.

const fs = require("node:fs");
const path = require("node:path");
const { UserError, mapLimit, throttle, extOf, newId, humanSize } = require("../lib/util");
const { scanTree } = require("../lib/scan");
const { ignoreFor } = require("../lib/ignore");
const { sameContent } = require("../lib/samefile");
const { renderTemplate } = require("./templates");

function sideStats(scan) {
  const extensions = new Map();
  const files = [];
  for (const item of scan.items.values()) {
    if (item.kind !== "file") continue;
    files.push(item);
    const ext = extOf(item.name) || "(none)";
    const e = extensions.get(ext) || { count: 0, size: 0 };
    e.count++;
    e.size += item.size;
    extensions.set(ext, e);
  }
  files.sort((x, y) => y.size - x.size);
  return {
    root: scan.root,
    name: path.basename(scan.root) || scan.root,
    files: scan.files,
    dirs: scan.dirs - 1,
    links: scan.links,
    size: scan.size,
    skipped: scan.skipped,
    errors: scan.errors.slice(0, 500),
    errorCount: scan.errors.length,
    extensions,
    largest: files.slice(0, 20).map((f) => ({ rel: f.rel, size: f.size })),
  };
}

function fileRow(item) {
  return { rel: item.rel, kind: item.kind, size: item.size, mtimeMs: item.mtimeMs, birthMs: item.birthMs };
}

async function compare(ctx, { a, b, options = {} }, task) {
  const settings = ctx.settings.get();
  const opts = {
    content: settings.compareContent,
    includeAll: settings.includeAll,
    toleranceMs: settings.toleranceMs,
    ...options,
  };
  if (!a || !b) throw new UserError("Choose two folders to compare.");
  if (path.resolve(a) === path.resolve(b)) throw new UserError("Those are the same folder.");
  const started = Date.now();

  const counts = { a: 0, b: 0 };
  const report = throttle((p) => task.progress(p), 150);
  const ignore = ignoreFor(opts);
  const [scanA, scanB] = await Promise.all([
    scanTree(a, { ignore, signal: task.signal, onProgress: (p) => report({ phase: "scan", scannedA: (counts.a = p.scanned), scannedB: counts.b }) }),
    scanTree(b, { ignore, signal: task.signal, onProgress: (p) => report({ phase: "scan", scannedA: counts.a, scannedB: (counts.b = p.scanned) }) }),
  ]);
  report.flush();

  const onlyA = [];
  const onlyB = [];
  const foldersOnlyA = [];
  const foldersOnlyB = [];
  const changed = [];
  const identical = [];
  const dateDiffs = [];
  const toCheck = [];
  const tol = opts.toleranceMs;

  const dateFlags = (x, y) => {
    const created = Math.abs(x.birthMs - y.birthMs) > tol;
    const modified = Math.abs(x.mtimeMs - y.mtimeMs) > tol;
    return created && modified ? "both" : created ? "created" : modified ? "modified" : null;
  };

  for (const [rel, ia] of scanA.items) {
    if (!rel) continue;
    const ib = scanB.items.get(rel);
    if (!ib) {
      if (ia.kind === "dir") foldersOnlyA.push(rel);
      else onlyA.push(fileRow(ia));
      continue;
    }
    if (ia.kind !== ib.kind) {
      changed.push({ rel, reason: "type", kindA: ia.kind, kindB: ib.kind, sizeA: ia.size, sizeB: ib.size, mtimeA: ia.mtimeMs, mtimeB: ib.mtimeMs });
      continue;
    }
    if (ia.kind === "dir") {
      const flag = dateFlags(ia, ib);
      if (flag) dateDiffs.push({ rel, kind: "dir", diff: flag, birthA: ia.birthMs, birthB: ib.birthMs, mtimeA: ia.mtimeMs, mtimeB: ib.mtimeMs });
      continue;
    }
    if (ia.kind === "link") {
      if (ia.linkTarget !== ib.linkTarget) changed.push({ rel, reason: "link", sizeA: 0, sizeB: 0, mtimeA: ia.mtimeMs, mtimeB: ib.mtimeMs });
      else identical.push({ rel, size: 0, check: "link", mtimeA: ia.mtimeMs, mtimeB: ib.mtimeMs, birthA: ia.birthMs, birthB: ib.birthMs });
      continue;
    }
    if (ia.size !== ib.size) {
      changed.push({ rel, reason: "size", sizeA: ia.size, sizeB: ib.size, mtimeA: ia.mtimeMs, mtimeB: ib.mtimeMs });
      continue;
    }
    // Smart skips reading only when size, modified date and created date all
    // match. A created date of 0 means the file system doesn't record one.
    const sameBirth = !(ia.birthMs > 0 && ib.birthMs > 0) || Math.abs(ia.birthMs - ib.birthMs) <= 1;
    const sameTime = Math.abs(ia.mtimeMs - ib.mtimeMs) <= 1 && sameBirth;
    if (opts.content === "size" || (opts.content === "smart" && sameTime) || ia.size === 0) {
      identical.push({ rel, size: ia.size, check: opts.content === "size" ? "size" : "quick", ia, ib });
    } else {
      toCheck.push({ rel, ia, ib });
    }
  }
  for (const [rel, ib] of scanB.items) {
    if (!rel || scanA.items.has(rel)) continue;
    if (ib.kind === "dir") foldersOnlyB.push(rel);
    else onlyB.push(fileRow(ib));
  }

  // Same size but possibly different bytes: read and compare.
  const totalBytes = toCheck.reduce((s, x) => s + x.ia.size, 0);
  let doneBytes = 0;
  let doneFiles = 0;
  const reportBytes = throttle((p) => task.progress(p), 150);
  await mapLimit(
    toCheck,
    4,
    async (x) => {
      let same = false;
      try {
        same = await sameContent(x.ia.path, x.ib.path, {
          signal: task.signal,
          onBytes: (n) => {
            doneBytes += n;
            reportBytes({ phase: "content", doneBytes, totalBytes, doneFiles, totalFiles: toCheck.length, current: x.rel });
          },
        });
      } catch (err) {
        if (err.code === "CANCELLED") throw err;
        changed.push({ rel: x.rel, reason: "unreadable", sizeA: x.ia.size, sizeB: x.ib.size, mtimeA: x.ia.mtimeMs, mtimeB: x.ib.mtimeMs });
        return;
      }
      doneFiles++;
      if (same) identical.push({ rel: x.rel, size: x.ia.size, check: "bytes", ia: x.ia, ib: x.ib });
      else changed.push({ rel: x.rel, reason: "content", sizeA: x.ia.size, sizeB: x.ib.size, mtimeA: x.ia.mtimeMs, mtimeB: x.ib.mtimeMs });
    },
    task.signal,
  );
  reportBytes.flush();

  const identicalRows = identical.map((x) => {
    if (!x.ia) return x;
    const flag = dateFlags(x.ia, x.ib);
    const row = { rel: x.rel, size: x.size, check: x.check, mtimeA: x.ia.mtimeMs, mtimeB: x.ib.mtimeMs, birthA: x.ia.birthMs, birthB: x.ib.birthMs, diff: flag };
    if (flag) dateDiffs.push({ rel: x.rel, kind: "file", diff: flag, birthA: x.ia.birthMs, birthB: x.ib.birthMs, mtimeA: x.ia.mtimeMs, mtimeB: x.ib.mtimeMs });
    return row;
  });

  const byRel = (x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0);
  [onlyA, onlyB, changed, identicalRows, dateDiffs].forEach((list) => list.sort(byRel));
  foldersOnlyA.sort();
  foldersOnlyB.sort();

  const statsA = sideStats(scanA);
  const statsB = sideStats(scanB);
  const extensions = [...new Set([...statsA.extensions.keys(), ...statsB.extensions.keys()])]
    .map((ext) => {
      const x = statsA.extensions.get(ext) || { count: 0, size: 0 };
      const y = statsB.extensions.get(ext) || { count: 0, size: 0 };
      return { ext, countA: x.count, countB: y.count, sizeA: x.size, sizeB: y.size };
    })
    .sort((x, y) => y.sizeA + y.sizeB - (x.sizeA + x.sizeB));
  delete statsA.extensions;
  delete statsB.extensions;

  const result = {
    id: newId("cmp"),
    generatedAt: Date.now(),
    elapsedMs: Date.now() - started,
    options: opts,
    a: statsA,
    b: statsB,
    counts: {
      onlyA: onlyA.length,
      onlyB: onlyB.length,
      foldersOnlyA: foldersOnlyA.length,
      foldersOnlyB: foldersOnlyB.length,
      changed: changed.length,
      identical: identicalRows.length,
      dateDiffs: dateDiffs.length,
      bytesChecked: totalBytes,
    },
    same: !onlyA.length && !onlyB.length && !foldersOnlyA.length && !foldersOnlyB.length && !changed.length,
    onlyA,
    onlyB,
    foldersOnlyA,
    foldersOnlyB,
    changed,
    identical: identicalRows,
    dateDiffs,
    extensions,
  };
  ctx.remember(result.id, result);
  return result;
}

async function compareExport(ctx, { id, output }) {
  const result = ctx.recall(id);
  if (!result) throw new UserError("That comparison is no longer in memory. Run it again, then export.");
  const html = renderTemplate("compare-report.html", {
    TITLE: `${result.a.name} vs ${result.b.name} — myFile comparison`,
    DATA: result,
  });
  await fs.promises.writeFile(output, html, "utf8");
  const bytes = Buffer.byteLength(html);
  return { output, bytes, sizeText: humanSize(bytes) };
}

module.exports = { compare, compareExport };

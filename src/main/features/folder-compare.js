"use strict";

// Folder › Compare: what's only in A, only in B, changed, identical, and
// which identical items have different dates. Exportable as an HTML report.

const fs = require("node:fs");
const path = require("node:path");
const { UserError, mapLimit, throttle, extOf, newId, humanSize } = require("../lib/util");
const { scanTree } = require("../lib/scan");
const { ignoreFor } = require("../lib/ignore");
const { sameContent, diffContent } = require("../lib/samefile");
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

const DETAIL_LIMIT = 200;
const IGNORED_TAG = /^(System:|ExifTool:|SourceFile$|File:(FileName|Directory|FileSize|FileModifyDate|FileAccessDate|FileInodeChangeDate|FileCreateDate|FilePermissions)$)/;

function tagText(v) {
  if (v === undefined) return null;
  return typeof v === "string" ? v : JSON.stringify(v);
}

const TEXT_LIMIT = 2 * 1024 * 1024;

const shorten = (t, n = 80) => (t.length > n ? `${t.slice(0, n)}…` : t);
const visible = (t) => t.replace(/\r/g, "␍").replace(/\t/g, "⇥");

/** Line-by-line differences if both files are small plain text, else null. */
async function textDifferences(fileA, fileB) {
  const [bufA, bufB] = await Promise.all([fs.promises.readFile(fileA), fs.promises.readFile(fileB)]);
  if (bufA.length > TEXT_LIMIT || bufA.includes(0) || bufB.includes(0)) return null;
  const A = bufA.toString("utf8").split("\n");
  const B = bufB.toString("utf8").split("\n");
  const lines = [];
  let total = 0;
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    if (A[i] === B[i]) continue;
    total++;
    if (lines.length < 30) lines.push({ line: i + 1, a: A[i] === undefined ? null : shorten(visible(A[i])), b: B[i] === undefined ? null : shorten(visible(B[i])) });
  }
  return total ? { lines, total } : null;
}

/** What differs between two same-size files that aren't byte-identical. */
async function describeDifference(ctx, fileA, fileB, signal) {
  const bytes = await diffContent(fileA, fileB, { signal });
  let tags = [];
  let tagCount = 0;
  try {
    const [[ra = {}], [rb = {}]] = await Promise.all([ctx.et.readJson([fileA], ["-G1", "-a", "-s"], { signal }), ctx.et.readJson([fileB], ["-G1", "-a", "-s"], { signal })]);
    const keys = [...new Set([...Object.keys(ra), ...Object.keys(rb)])].filter((k) => !IGNORED_TAG.test(k));
    tagCount = keys.filter((k) => !k.startsWith("File:")).length;
    tags = keys
      .map((k) => ({ tag: k, a: tagText(ra[k]), b: tagText(rb[k]) }))
      .filter((t) => t.a !== t.b)
      .map((t) => ({ tag: t.tag, a: t.a && t.a.length > 160 ? `${t.a.slice(0, 160)}…` : t.a, b: t.b && t.b.length > 160 ? `${t.b.slice(0, 160)}…` : t.b }));
  } catch (err) {
    if (err.code === "CANCELLED") throw err;
  }
  const text = tags.length ? null : await textDifferences(fileA, fileB).catch(() => null);
  const names = tags.map((t) => t.tag.replace(/^[^:]+:/, ""));
  let summary;
  if (tags.length) {
    summary = `Metadata differs: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3} more` : ""}`;
  } else if (text) {
    const f = text.lines[0];
    summary = `Text differs on line ${f.line}: “${f.a ?? ""}” → “${f.b ?? ""}”${text.total > 1 ? ` (+${text.total - 1} more ${text.total === 2 ? "line" : "lines"})` : ""}`;
  } else if (tagCount) {
    summary = "Metadata is the same; the picture/video/data itself differs";
  } else {
    summary = `${bytes.differingBytes.toLocaleString("en-US")}${bytes.partial ? "+" : ""} ${bytes.differingBytes === 1 && !bytes.partial ? "byte differs" : "bytes differ"}, first at byte ${bytes.firstOffset.toLocaleString("en-US")}`;
  }
  return { summary, tags: tags.slice(0, 200), tagsTotal: tags.length, text, ...bytes };
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
    const sameTime = Math.abs(ia.mtimeMs - ib.mtimeMs) <= 1;
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

  // Explain *how* same-size files differ (metadata tags and raw bytes), for the first few.
  const explain = changed.filter((x) => x.reason === "content");
  const byPath = new Map(toCheck.map((x) => [x.rel, x]));
  let explained = 0;
  for (const row of explain.slice(0, DETAIL_LIMIT)) {
    const x = byPath.get(row.rel);
    if (!x) continue;
    task.progress({ phase: "explain", current: row.rel, doneFiles: explained, totalFiles: Math.min(explain.length, DETAIL_LIMIT) });
    row.detail = await describeDifference(ctx, x.ia.path, x.ib.path, task.signal).catch((err) => {
      if (err.code === "CANCELLED") throw err;
      return null;
    });
    explained++;
  }

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

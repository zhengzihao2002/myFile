"use strict";

// Folder › Generate HTML
//
// Writes one self-contained HTML page listing a folder tree with creation,
// modification and (optionally) EXIF dates. The page carries its data as
// JSON, so it doubles as a reference for Folder › Modify: point Modify at the
// HTML and it restores those dates onto a copy of the folder.

const fs = require("node:fs");
const path = require("node:path");
const { UserError, throttle, humanSize, relKey, joinRel, depthOf, checkCancel } = require("../lib/util");
const { scanTree } = require("../lib/scan");
const { ignoreFor } = require("../lib/ignore");
const { isMedia } = require("../lib/media");
const { splitKey } = require("../lib/exiftool");
const { renderTemplate } = require("./templates");

const FORMAT = "myfile-index";
const VERSION = 1;

// Date tags worth carrying over: EXIF, XMP, IPTC, QuickTime and PNG dates,
// sub-seconds and zone offsets. Skips file-system, computed and maker-note
// values, and XMP edit history (a list we shouldn't flatten).
const SNAPSHOT_GROUPS = new Set(["EXIF", "XMP", "IPTC", "QuickTime", "PNG"]);

function dateSnapshot(tags) {
  const snap = {};
  for (const [key, value] of Object.entries(tags || {})) {
    if (key === "SourceFile") continue;
    const { group0, group1, tag } = splitKey(key);
    if (!SNAPSHOT_GROUPS.has(group0)) continue;
    if (group1 === "XMP-xmpMM" || Array.isArray(value) || typeof value === "object") continue;
    snap[`${group1}:${tag}`] = String(value);
  }
  return Object.keys(snap).length ? snap : null;
}

/** EXIF date snapshots for every media file among `items` (a scan's item list). */
async function readSnapshots(ctx, files, { signal, onProgress } = {}) {
  const out = new Map();
  for (let i = 0; i < files.length; i += 100) {
    checkCancel(signal);
    const chunk = files.slice(i, i + 100);
    const rows = await ctx.et.readJson(chunk.map((f) => f.path), ["-G0:1", "-a", "-s", "-time:all"], { signal });
    const bySource = new Map(rows.map((r) => [String(r.SourceFile).normalize("NFC"), r]));
    for (const f of chunk) {
      const snap = dateSnapshot(bySource.get(f.path.normalize("NFC")));
      if (snap) out.set(f.rel, snap);
    }
    if (onProgress) onProgress({ done: Math.min(i + 100, files.length), total: files.length, current: chunk[chunk.length - 1].rel });
  }
  return out;
}

function toNode(item, snapshots) {
  const node = {
    n: item.name,
    t: item.kind === "dir" ? "d" : item.kind === "link" ? "l" : "f",
    s: item.kind === "dir" ? item.bytes || 0 : item.size,
    c: item.birthMs,
    m: item.mtimeMs,
    a: item.atimeMs,
  };
  if (item.kind === "link" && item.linkTarget) node.lt = item.linkTarget;
  if (item.error) node.e = item.error;
  const snap = snapshots && snapshots.get(item.rel);
  if (snap) node.x = snap;
  return node;
}

function buildTree(items, snapshots) {
  const nodes = new Map();
  for (const item of items.values()) nodes.set(item.rel, toNode(item, snapshots));
  const sorted = [...items.values()].sort((a, b) => a.depth - b.depth || a.rel.localeCompare(b.rel));
  for (const item of sorted) {
    if (!item.rel) continue;
    const parentRel = item.rel.includes("/") ? item.rel.slice(0, item.rel.lastIndexOf("/")) : "";
    const parent = nodes.get(parentRel);
    if (!parent) continue;
    (parent.k || (parent.k = [])).push(nodes.get(item.rel));
  }
  return nodes.get("");
}

async function generateIndex(ctx, { folder, output, options = {} }, task) {
  const opts = { exif: true, includeAll: false, ...options };
  if (!folder) throw new UserError("Choose a folder first.");
  if (!output) throw new UserError("Choose where to save the HTML file.");

  const report = throttle((p) => task.progress(p), 150);
  const scan = await scanTree(folder, {
    ignore: ignoreFor(opts),
    signal: task.signal,
    onProgress: (p) => report({ phase: "scan", scanned: p.scanned }),
  });
  report.flush();

  let snapshots = null;
  let mediaCount = 0;
  if (opts.exif) {
    const media = [...scan.items.values()].filter((it) => it.kind === "file" && isMedia(it.name));
    mediaCount = media.length;
    snapshots = await readSnapshots(ctx, media, {
      signal: task.signal,
      onProgress: (p) => report({ phase: "exif", ...p }),
    });
    report.flush();
  }

  const data = {
    format: FORMAT,
    version: VERSION,
    app: `myFile ${ctx.appVersion || ""}`.trim(),
    generatedAt: Date.now(),
    root: path.resolve(folder),
    name: path.basename(path.resolve(folder)),
    options: { exif: Boolean(opts.exif), includeAll: Boolean(opts.includeAll) },
    stats: {
      dirs: scan.dirs - 1,
      files: scan.files,
      links: scan.links,
      size: scan.size,
      skipped: scan.skipped,
      media: mediaCount,
      withExif: snapshots ? snapshots.size : 0,
      errors: scan.errors.slice(0, 50).map((e) => `${e.rel || "."}: ${e.error}`),
      errorCount: scan.errors.length,
    },
    tree: buildTree(scan.items, snapshots),
  };

  const html = renderTemplate("folder-index.html", { TITLE: `${data.name} — folder index`, DATA: data });
  await fs.promises.mkdir(path.dirname(output), { recursive: true });
  await fs.promises.writeFile(output, html, "utf8");
  const bytes = Buffer.byteLength(html);
  return {
    output,
    bytes,
    sizeText: humanSize(bytes),
    stats: data.stats,
    insideFolder: path.resolve(output).startsWith(path.resolve(folder) + path.sep),
  };
}

// ---------------------------------------------------------------------------
// Reading an index back (ours, or the file_directory.html from main.py)
// ---------------------------------------------------------------------------

function extractScript(html, id) {
  const re = new RegExp(`<script[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)</script>`, "i");
  const m = re.exec(html);
  return m ? m[1] : null;
}

function fromLegacy(node) {
  const out = {
    n: node.name,
    t: node.type === "dir" ? "d" : node.link ? "l" : "f",
    s: node.size || 0,
    c: Number(node.created_ts) * 1000,
    m: Number(node.modified_ts) * 1000,
  };
  if (Array.isArray(node.children) && node.children.length) out.k = node.children.map(fromLegacy);
  return out;
}

function parseIndexHtml(html) {
  const ours = extractScript(html, "myfile-index");
  if (ours) {
    const data = JSON.parse(ours);
    if (data.format !== FORMAT) throw new UserError("This HTML file wasn't made by myFile.");
    return { kind: "myfile", ...data };
  }
  const legacy = extractScript(html, "tree-data");
  if (legacy) {
    const tree = fromLegacy(JSON.parse(legacy));
    return {
      kind: "legacy",
      format: "file_directory.py",
      generatedAt: null,
      root: JSON.parse(legacy).path || "",
      name: tree.n,
      options: { exif: false },
      tree,
    };
  }
  throw new UserError("This HTML file doesn't contain a folder index. Use one made by Folder › Generate HTML.");
}

/** Flattens an index tree into scan-style items keyed by relative path. */
function indexToItems(index) {
  const items = new Map();
  const walk = (node, rel) => {
    const kind = node.t === "d" ? "dir" : node.t === "l" ? "link" : "file";
    items.set(rel, {
      rel,
      name: node.n,
      kind,
      depth: depthOf(rel),
      size: kind === "file" ? node.s || 0 : 0,
      birthMs: Number.isFinite(node.c) ? node.c : null,
      mtimeMs: Number.isFinite(node.m) ? node.m : null,
      atimeMs: Number.isFinite(node.a) ? node.a : null,
      linkTarget: node.lt || null,
      exif: node.x || null,
    });
    for (const child of node.k || []) walk(child, joinRel(rel, relKey(child.n)));
  };
  walk(index.tree, "");
  return items;
}

async function readIndexFile(file) {
  let html;
  try {
    html = await fs.promises.readFile(file, "utf8");
  } catch {
    throw new UserError(`Can't read ${path.basename(file)}.`);
  }
  return parseIndexHtml(html);
}

module.exports = { generateIndex, parseIndexHtml, indexToItems, readIndexFile, readSnapshots, dateSnapshot, buildTree };

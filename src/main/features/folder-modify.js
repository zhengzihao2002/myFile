"use strict";

// Folder › Modify
//
// Makes the dates in one or more TARGET folders match a REFERENCE: either a
// folder, or an HTML index made by Generate HTML. A target is only touched
// if its structure matches the reference exactly (same names, same nesting,
// same file/folder types; sizes too if asked). Dates and EXIF are not part of
// that check, because they are what gets fixed: creation and modification
// dates of every file and folder, and the EXIF/QuickTime dates inside photos
// and videos. Nothing in the reference is ever written to.

const fs = require("node:fs");
const path = require("node:path");
const { UserError, throttle, checkCancel, parentRel, newId, isInside } = require("../lib/util");
const { scanTree } = require("../lib/scan");
const { ignoreFor } = require("../lib/ignore");
const { isMedia } = require("../lib/media");
const { applyTimes, canSetBirthtime } = require("../lib/filetimes");
const { readIndexFile, indexToItems, readSnapshots } = require("./folder-index");

const LIST_LIMIT = 400;

async function loadReference(ctx, reference, opts, task, report) {
  let st;
  try {
    st = await fs.promises.stat(reference);
  } catch {
    throw new UserError("The reference can't be opened. Choose a folder or an HTML index.");
  }
  if (st.isFile()) {
    if (!/\.html?$/i.test(reference)) throw new UserError("A reference file must be an HTML index made by Generate HTML.");
    const index = await readIndexFile(reference);
    return {
      kind: "html",
      path: reference,
      name: index.name,
      originalRoot: index.root,
      generatedAt: index.generatedAt,
      legacy: index.kind === "legacy",
      hasExif: Boolean(index.options && index.options.exif),
      items: indexToItems(index),
    };
  }
  const scan = await scanTree(reference, {
    ignore: ignoreFor(opts),
    signal: task.signal,
    onProgress: (p) => report({ phase: "scan-reference", scanned: p.scanned }),
  });
  if (scan.errors.length) {
    throw new UserError(`${scan.errors.length} item(s) in the reference can't be read, so it can't be compared fairly. First: ${scan.errors[0].rel || "."} (${scan.errors[0].error})`);
  }
  const ref = { kind: "folder", path: reference, name: path.basename(reference), hasExif: Boolean(opts.exif), items: scan.items };
  if (opts.exif) {
    const media = [...scan.items.values()].filter((it) => it.kind === "file" && isMedia(it.name));
    const snaps = await readSnapshots(ctx, media, { signal: task.signal, onProgress: (p) => report({ phase: "exif-reference", ...p }) });
    for (const [rel, snap] of snaps) scan.items.get(rel).exif = snap;
  }
  return ref;
}

function compareStructure(refItems, items, requireSameSize) {
  const missing = [];
  const extra = [];
  const kind = [];
  const size = [];
  for (const [rel, r] of refItems) {
    const t = items.get(rel);
    if (!t) missing.push(rel);
    else if (r.kind !== t.kind) kind.push({ rel, ref: r.kind, target: t.kind });
    else if (r.kind === "file" && r.size !== t.size) size.push({ rel, ref: r.size, target: t.size });
  }
  for (const rel of items.keys()) if (!refItems.has(rel)) extra.push(rel);
  const blocking = missing.length + extra.length + kind.length + (requireSameSize ? size.length : 0);
  return { missing, extra, kind, size, blocking };
}

function diffItems(refItems, items, opts) {
  const tol = opts.toleranceMs;
  const diffs = [];
  for (const [rel, r] of refItems) {
    // The top folder of a drive has no dates of its own worth changing.
    if (!rel && opts.skipRoot) continue;
    const t = items.get(rel);
    const entry = { rel, kind: r.kind, path: t.path };
    let any = false;
    if (opts.created && Number.isFinite(r.birthMs) && Math.abs(r.birthMs - t.birthMs) > tol && r.kind !== "link") {
      entry.birth = { now: t.birthMs, to: r.birthMs };
      any = true;
    }
    if (opts.modified && Number.isFinite(r.mtimeMs) && Math.abs(r.mtimeMs - t.mtimeMs) > tol) {
      entry.mtime = { now: t.mtimeMs, to: r.mtimeMs };
      any = true;
    }
    if (opts.exif && r.exif && r.kind === "file") {
      const changes = [];
      for (const [tag, value] of Object.entries(r.exif)) {
        const current = t.exif ? t.exif[tag] : undefined;
        if (current !== value) changes.push([tag, current === undefined ? null : current, value]);
      }
      if (changes.length) {
        entry.exif = changes;
        any = true;
      }
    }
    if (any) diffs.push(entry);
  }
  diffs.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return diffs;
}

async function modifyPlan(ctx, { reference, targets, options = {} }, task) {
  const settings = ctx.settings.get();
  const opts = {
    created: true,
    modified: true,
    exif: true,
    requireSameSize: false,
    includeAll: settings.includeAll,
    toleranceMs: settings.toleranceMs,
    ...options,
  };
  if (!reference) throw new UserError("Choose a reference folder or HTML index.");
  if (!targets || !targets.length) throw new UserError("Add at least one target folder.");

  const report = throttle((p) => task.progress(p), 150);
  const ref = await loadReference(ctx, reference, opts, task, report);
  const useExif = opts.exif && ref.hasExif;
  const notes = [];
  if (opts.created && !canSetBirthtime()) {
    notes.push("Created dates can only be set on macOS, so only modified dates will be fixed here.");
    opts.created = false;
  }
  if (opts.exif && !ref.hasExif) {
    notes.push(ref.legacy
      ? "This HTML index has no EXIF dates (it was made by file_directory.py), so only file dates will be fixed."
      : "This HTML index was made without EXIF dates, so only file dates will be fixed.");
  }

  const results = [];
  for (const [i, target] of targets.entries()) {
    checkCancel(task.signal);
    const res = { path: target, name: path.basename(target), index: i };
    results.push(res);
    if (ref.kind === "folder" && (path.resolve(target) === path.resolve(reference))) {
      res.status = "error";
      res.error = "This is the reference folder itself.";
      continue;
    }
    if (ref.kind === "folder" && (isInside(target, reference) || isInside(reference, target))) {
      res.status = "error";
      res.error = "One of these folders is inside the other.";
      continue;
    }
    let scan;
    try {
      scan = await scanTree(target, {
        ignore: ignoreFor(opts),
        signal: task.signal,
        onProgress: (p) => report({ phase: "scan-target", target: res.name, scanned: p.scanned }),
      });
    } catch (err) {
      if (err.code === "CANCELLED") throw err;
      res.status = "error";
      res.error = err.message;
      continue;
    }
    if (ref.kind === "html") {
      // The HTML file itself may sit inside the target; it isn't part of the tree.
      const rel = path.relative(target, reference).split(path.sep).join("/");
      if (!rel.startsWith("..") && scan.items.has(rel.normalize("NFC")) && !ref.items.has(rel.normalize("NFC"))) {
        scan.items.delete(rel.normalize("NFC"));
      }
    }
    if (scan.errors.length) {
      res.status = "error";
      res.error = `${scan.errors.length} item(s) can't be read. First: ${scan.errors[0].rel} (${scan.errors[0].error})`;
      continue;
    }
    // External drives: exFAT keeps times in 10 ms steps, FAT32 in 2 s steps.
    const volume = await ctx.volumes.info(target);
    if (!volume.writable) {
      res.status = "error";
      res.error = volume.fsType === "ntfs" ? `${volume.name} is formatted NTFS, which macOS can read but not change.` : volume.volumeWritable ? `You don't have permission to change this folder. Check its permissions in Finder (Get Info › Sharing & Permissions).` : `${volume.name} is read-only.`;
      continue;
    }
    res.tol = Math.max(opts.toleranceMs, volume.granularityMs);
    res.skipRoot = path.resolve(target) === volume.mountPoint;
    const structure = compareStructure(ref.items, scan.items, opts.requireSameSize);
    res.counts = { files: scan.files, dirs: scan.dirs - 1, size: scan.size };
    if (structure.blocking) {
      res.status = "mismatch";
      res.problems = {
        missing: structure.missing.slice(0, LIST_LIMIT),
        extra: structure.extra.slice(0, LIST_LIMIT),
        kind: structure.kind.slice(0, LIST_LIMIT),
        size: opts.requireSameSize ? structure.size.slice(0, LIST_LIMIT) : [],
      };
      res.problemCounts = {
        missing: structure.missing.length,
        extra: structure.extra.length,
        kind: structure.kind.length,
        size: opts.requireSameSize ? structure.size.length : 0,
      };
      continue;
    }
    res.sizeWarnings = structure.size.length;
    if (useExif) {
      const media = [...scan.items.values()].filter((it) => it.kind === "file" && ref.items.get(it.rel) && ref.items.get(it.rel).exif);
      const snaps = await readSnapshots(ctx, media, { signal: task.signal, onProgress: (p) => report({ phase: "exif-target", target: res.name, ...p }) });
      for (const it of media) it.exif = snaps.get(it.rel) || {};
    }
    const diffs = diffItems(ref.items, scan.items, { ...opts, exif: useExif, toleranceMs: res.tol, skipRoot: res.skipRoot });
    res.status = diffs.length ? "match" : "same";
    res.diffs = diffs;
    res.summary = {
      items: diffs.length,
      created: diffs.filter((d) => d.birth).length,
      modified: diffs.filter((d) => d.mtime).length,
      exif: diffs.filter((d) => d.exif).length,
    };
  }
  report.flush();

  const plan = {
    id: newId("mod"),
    reference: {
      path: ref.path,
      kind: ref.kind,
      name: ref.name,
      originalRoot: ref.originalRoot || null,
      generatedAt: ref.generatedAt || null,
      legacy: Boolean(ref.legacy),
      hasExif: ref.hasExif,
      items: ref.items.size,
    },
    options: { ...opts, exif: useExif },
    notes,
    targets: results,
  };
  // Keep the reference values for apply; the renderer only needs the summary.
  ctx.remember(plan.id, { plan, refItems: ref.items });
  return plan;
}

async function modifyApply(ctx, { planId, targets: chosen }, task) {
  const saved = ctx.recall(planId);
  if (!saved) throw new UserError("This check is out of date. Run the check again.");
  const { plan, refItems } = saved;
  const opts = plan.options;
  const todo = plan.targets.filter((t) => t.status === "match" && (!chosen || chosen.includes(t.index)));
  const undo = { times: [], exif: [] };
  const report = [];
  const totalItems = todo.reduce((s, t) => s + t.diffs.length, 0);
  let doneItems = 0;

  for (const target of todo) {
    checkCancel(task.signal);
    const out = { path: target.path, name: target.name, exifWritten: 0, exifFailed: [], timeFailures: [], remaining: null };
    report.push(out);
    const relPath = (rel) => (rel ? path.join(target.path, ...rel.split("/")) : target.path);

    // Writing EXIF creates a temporary file next to each photo, which changes
    // the parent folder's modification date. Those folders get reset below.
    const exifDiffs = target.diffs.filter((d) => d.exif);
    const ancestors = (rel) => {
      const list = [];
      let p = rel;
      while (p) {
        p = parentRel(p);
        list.push(p);
      }
      return list;
    };
    const maybeTouched = new Set(exifDiffs.flatMap((d) => ancestors(d.rel)));

    // Current dates of everything we may change: for undo, and to put back
    // folder dates the user didn't ask to change.
    const before = new Map();
    const dated = target.diffs.filter((d) => d.birth || d.mtime).map((d) => d.rel);
    for (const rel of new Set([...dated, ...maybeTouched])) {
      try {
        const st = await fs.promises.lstat(relPath(rel));
        before.set(rel, { path: relPath(rel), birthMs: st.birthtimeMs, mtimeMs: st.mtimeMs, atimeMs: st.atimeMs, isLink: st.isSymbolicLink() });
      } catch {
        // vanished since the check; applyTimes will report it
      }
    }

    // 1. EXIF dates inside the files (in place, keeping the file's own dates).
    const touched = new Set();
    for (const d of exifDiffs) {
      checkCancel(task.signal);
      task.progress({ phase: "exif", target: target.name, current: d.rel, done: doneItems, total: totalItems });
      try {
        await ctx.et.write(d.path, d.exif.map(([tag, , value]) => [tag, value]), { signal: task.signal });
        undo.exif.push({ path: d.path, tags: d.exif.map(([tag, oldValue]) => [tag, oldValue]) });
        out.exifWritten++;
        for (const a of ancestors(d.rel)) touched.add(a);
      } catch (err) {
        if (err.code === "CANCELLED") throw err;
        out.exifFailed.push({ rel: d.rel, error: err.message });
      }
    }

    // 2. File and folder dates.
    const entries = new Map();
    for (const d of target.diffs) {
      doneItems++;
      if (!d.birth && !d.mtime) continue;
      const r = refItems.get(d.rel);
      entries.set(d.rel, {
        path: d.path,
        isLink: d.kind === "link",
        birthMs: d.birth ? r.birthMs : undefined,
        mtimeMs: d.mtime ? r.mtimeMs : undefined,
      });
    }
    for (const rel of touched) {
      if (!rel && target.skipRoot) continue;
      const e = entries.get(rel) || { path: relPath(rel), isLink: false };
      if (e.mtimeMs === undefined) {
        const r = refItems.get(rel);
        e.mtimeMs = opts.modified && r && Number.isFinite(r.mtimeMs) ? r.mtimeMs : before.has(rel) ? before.get(rel).mtimeMs : undefined;
      }
      entries.set(rel, e);
    }
    for (const rel of entries.keys()) if (before.has(rel)) undo.times.push(before.get(rel));

    task.progress({ phase: "dates", target: target.name, done: doneItems, total: totalItems });
    const res = await applyTimes([...entries.values()], { signal: task.signal });
    out.timeFailures = res.failures;
    out.birthUnsupported = res.birthUnsupported;
    out.datesSet = entries.size - res.failures.length;

    // 3. Verify by reading the target again.
    try {
      const fresh = await scanTree(target.path, { ignore: ignoreFor(opts), signal: task.signal });
      const check = diffItems(refItems, fresh.items, { ...opts, exif: false, toleranceMs: Math.max(target.tol || 0, opts.toleranceMs), skipRoot: target.skipRoot });
      out.remaining = check.length;
      out.remainingSample = check.slice(0, 20).map((d) => d.rel || ".");
    } catch (err) {
      if (err.code === "CANCELLED") throw err;
      out.remaining = null;
    }
  }

  const changed = report.reduce((s, r) => s + (r.datesSet || 0), 0);
  const exifCount = report.reduce((s, r) => s + r.exifWritten, 0);
  const entry = ctx.history.add({
    type: "folder-modify",
    title: `Fixed dates from ${plan.reference.name}`,
    summary: `${todo.length} folder${todo.length === 1 ? "" : "s"} · ${changed} date${changed === 1 ? "" : "s"} set · ${exifCount} EXIF update${exifCount === 1 ? "" : "s"}`,
    details: { reference: plan.reference.path, targets: todo.map((t) => t.path), options: opts },
    undo,
  });
  return { targets: report, historyId: entry.id };
}

module.exports = { modifyPlan, modifyApply, compareStructure, diffItems };

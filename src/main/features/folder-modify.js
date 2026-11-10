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
const { snapshotTags } = require("./exif-copy");

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

// A checked plan must describe the same files at Apply time. Access times are
// deliberately omitted: previewing/reading a file is not an external edit.
const checkedIdentities = new WeakMap();

function statIdentity(st) {
  return [st.dev, st.ino, st.mode, st.size, st.birthtimeMs, st.mtimeMs, st.ctimeMs];
}

async function captureItems(items, signal) {
  const snapshot = [];
  for (const [rel, item] of [...items].sort(([a], [b]) => a.localeCompare(b))) {
    checkCancel(signal);
    const st = await fs.promises.lstat(item.path);
    // Do not bless a mixed snapshot if the file changed during the Check read.
    if (st.mtimeMs !== item.mtimeMs || st.birthtimeMs !== item.birthMs || (item.kind === "file" && st.size !== item.size)) {
      throw new UserError(`“${rel || "."}” changed while being checked. Run the check again.`);
    }
    checkedIdentities.set(item, statIdentity(st));
    snapshot.push([rel, item.kind, item.linkTarget || null, statIdentity(st), item.exif || null]);
  }
  return JSON.stringify(snapshot);
}

async function assertUnchanged(item) {
  const st = await fs.promises.lstat(item.path);
  if (JSON.stringify(statIdentity(st)) !== JSON.stringify(checkedIdentities.get(item))) {
    throw new UserError(`“${item.rel || "."}” changed since Check. Run the check again before applying.`);
  }
  return st;
}

async function captureReference(ref, signal) {
  if (ref.kind === "html") {
    checkCancel(signal);
    return JSON.stringify(statIdentity(await fs.promises.lstat(ref.path)));
  }
  return captureItems(ref.items, signal);
}

function excludeReferenceHtml(scan, ref) {
  if (ref.kind !== "html") return;
  const rel = path.relative(scan.root, ref.path).split(path.sep).join("/");
  if (!rel.startsWith("..") && !ref.items.has(rel.normalize("NFC"))) scan.items.delete(rel.normalize("NFC"));
}

async function readTarget(ctx, target, ref, opts, task) {
  const scan = await scanTree(target.path, { ignore: ignoreFor(opts), signal: task.signal });
  excludeReferenceHtml(scan, ref);
  if (scan.errors.length) throw new UserError(`“${target.name}” cannot be rechecked completely. Run the check again.`);
  if (opts.exif) {
    const media = [...scan.items.values()].filter((it) => it.kind === "file" && ref.items.get(it.rel) && ref.items.get(it.rel).exif);
    const snaps = await readSnapshots(ctx, media, { signal: task.signal });
    for (const it of media) it.exif = snaps.get(it.rel) || {};
  }
  return scan;
}

async function modifyPlan(ctx, { reference, targets, options = {} }, task) {
  const settings = ctx.settings.get();
  const opts = {
    created: true,
    modified: true,
    exif: true,
    requireSameSize: false,
    includeAll: false,
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
  const targetSnapshots = new Map();
  const referenceSnapshot = await captureReference(ref, task.signal);
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
    targetSnapshots.set(res.index, await captureItems(scan.items, task.signal));
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
  ctx.remember(plan.id, { plan, refItems: ref.items, referenceSnapshot, targetSnapshots });
  return plan;
}

async function modifyApply(ctx, { planId, targets: chosen }, task) {
  const saved = ctx.recall(planId);
  if (!saved) throw new UserError("This check is out of date. Run the check again.");
  const { plan, refItems } = saved;
  const opts = plan.options;
  const todo = plan.targets.filter((t) => t.status === "match" && (!chosen || chosen.includes(t.index)));

  // Revalidate every selected target before the first write, so a stale second
  // target cannot leave the first one modified by a plan the user never saw.
  task.progress({ phase: "recheck", current: plan.reference.name });
  let freshRef;
  const freshTargets = new Map();
  try {
    freshRef = await loadReference(ctx, plan.reference.path, opts, task, (p) => task.progress(p));
    if (await captureReference(freshRef, task.signal) !== saved.referenceSnapshot) {
      throw new UserError("The reference changed since Check. Run the check again before applying.");
    }
    for (const target of todo) {
      task.progress({ phase: "recheck", target: target.name, current: target.name });
      const scan = await readTarget(ctx, target, freshRef, opts, task);
      if (await captureItems(scan.items, task.signal) !== saved.targetSnapshots.get(target.index)) {
        throw new UserError(`“${target.name}” changed since Check. Run the check again before applying.`);
      }
      freshTargets.set(target.index, scan.items);
    }
  } catch (err) {
    if (err.code === "CANCELLED") throw err;
    if (err instanceof UserError && /check again/i.test(err.message)) throw err;
    throw new UserError(`The checked files changed or cannot be revalidated (${err.message}). Run the check again.`);
  }

  const report = [];
  const restoreFolders = new Map();
  const restoreFiles = new Map();
  let historyId = null;
  let cancelled = false;
  const totalItems = todo.reduce((n, t) => n + t.diffs.length, 0);
  let doneItems = 0;
  const details = { reference: plan.reference.path, targets: todo.map((t) => t.path), options: opts };
  const journal = (undo) => {
    const summary = "Folder date changes in progress; recovery saved before writing";
    if (historyId && ctx.history.append(historyId, { undo, summary, details })) return;
    historyId = ctx.history.add({ type: "folder-modify", title: `Fixed dates from ${plan.reference.name}`, summary, details, undo }).id;
  };
  const timeOf = (item) => ({ path: item.path, birthMs: item.birthMs, mtimeMs: item.mtimeMs, atimeMs: item.atimeMs, isLink: item.kind === "link", dir: item.kind === "dir" });
  const ancestors = (rel) => {
    const list = [];
    while (rel) { rel = parentRel(rel); list.push(rel); }
    return list;
  };

  try {
    for (const target of todo) {
      checkCancel(task.signal);
      const items = freshTargets.get(target.index);
      const out = { path: target.path, name: target.name, exifWritten: 0, exifFailed: [], timeFailures: [], datesSet: 0, remaining: null };
      report.push(out);
      const touched = new Set();
      const writtenFiles = new Set();
      for (const d of target.diffs.filter((d) => d.exif)) {
        checkCancel(task.signal);
        const writes = d.exif.map(([tag, , value]) => [tag, value]);
        // Snapshot the actual tags immediately before the write, not the old
        // values that happened to be displayed when Check was pressed.
        const tags = await snapshotTags(ctx, d.path, writes, task.signal);
        const actual = await assertUnchanged(items.get(d.rel));
        const fileBefore = { ...timeOf(items.get(d.rel)), birthMs: actual.birthtimeMs, mtimeMs: actual.mtimeMs, atimeMs: actual.atimeMs };
        const foldersBefore = [];
        for (const rel of ancestors(d.rel)) {
          const item = items.get(rel);
          if (!touched.has(rel)) await assertUnchanged(item);
          foldersBefore.push(timeOf(item));
        }
        journal({ exif: [{ path: d.path, tags }], times: [fileBefore, ...foldersBefore] });
        restoreFiles.set(d.path, fileBefore);
        for (const f of foldersBefore) restoreFolders.set(f.path, f);
        for (const rel of ancestors(d.rel)) touched.add(rel);
        task.progress({ phase: "exif", target: target.name, current: d.rel, done: doneItems, total: totalItems });
        try {
          writtenFiles.add(d.rel);
          await ctx.et.write(d.path, writes, { signal: task.signal });
          out.exifWritten++;
        } catch (err) {
          if (err.code === "CANCELLED") throw err;
          out.exifFailed.push({ rel: d.rel, error: err.message });
        }
      }

      const entries = new Map();
      for (const d of target.diffs) {
        doneItems++;
        if (!d.birth && !d.mtime) continue;
        const ref = refItems.get(d.rel);
        entries.set(d.rel, { path: d.path, isLink: d.kind === "link", birthMs: d.birth ? ref.birthMs : undefined, mtimeMs: d.mtime ? ref.mtimeMs : undefined });
      }
      for (const rel of touched) {
        if (!rel && target.skipRoot) continue;
        const before = items.get(rel);
        const entry = entries.get(rel) || { path: before.path, isLink: false };
        if (entry.mtimeMs === undefined) {
          const ref = refItems.get(rel);
          entry.mtimeMs = opts.modified && ref && Number.isFinite(ref.mtimeMs) ? ref.mtimeMs : before.mtimeMs;
        }
        entries.set(rel, entry);
      }
      const timeSnapshots = [];
      for (const rel of entries.keys()) {
        const item = items.get(rel);
        const st = writtenFiles.has(rel) || touched.has(rel) ? await fs.promises.lstat(item.path) : await assertUnchanged(item);
        timeSnapshots.push({ ...timeOf(item), birthMs: st.birthtimeMs, mtimeMs: st.mtimeMs, atimeMs: st.atimeMs });
      }
      if (entries.size) journal({ times: timeSnapshots });
      task.progress({ phase: "dates", target: target.name, done: doneItems, total: totalItems });
      const res = await applyTimes([...entries.values()], { signal: task.signal });
      out.timeFailures.push(...res.failures);
      out.birthUnsupported = res.birthUnsupported;
      out.datesSet = entries.size - res.failures.length;
      const failed = new Set(res.failures.map((f) => f.path));
      for (const entry of entries.values()) {
        if (!failed.has(entry.path)) { restoreFiles.delete(entry.path); restoreFolders.delete(entry.path); }
      }
      // EXIF-only operations preserve each file's own times as well as folders.
      const pending = [...restoreFiles.values()].filter((f) => items.has(path.relative(target.path, f.path).split(path.sep).join("/")));
      if (pending.length) {
        const restored = await applyTimes(pending, { signal: task.signal });
        out.timeFailures.push(...restored.failures);
        const bad = new Set(restored.failures.map((f) => f.path));
        for (const f of pending) if (!bad.has(f.path)) restoreFiles.delete(f.path);
      }
      try {
        const fresh = await scanTree(target.path, { ignore: ignoreFor(opts), signal: task.signal });
        excludeReferenceHtml(fresh, freshRef);
        const check = diffItems(refItems, fresh.items, { ...opts, exif: false, toleranceMs: Math.max(target.tol || 0, opts.toleranceMs), skipRoot: target.skipRoot });
        out.remaining = check.length;
        out.remainingSample = check.slice(0, 20).map((d) => d.rel || ".");
      } catch (err) {
        if (err.code === "CANCELLED") throw err;
      }
    }
  } catch (err) {
    if (err.code !== "CANCELLED") throw err;
    cancelled = true;
  } finally {
    // This cleanup must run even when the operation's AbortSignal is aborted.
    // The journal already exists if a disconnect prevents restoration here.
    const pending = [...restoreFiles.values(), ...restoreFolders.values()];
    if (pending.length) {
      const res = await applyTimes(pending);
      if (report.length) report[report.length - 1].timeFailures.push(...res.failures);
    }
    if (historyId) {
      const changed = report.reduce((n, t) => n + t.datesSet, 0);
      const exif = report.reduce((n, t) => n + t.exifWritten, 0);
      ctx.history.append(historyId, { summary: `${cancelled ? "Cancelled; " : ""}${changed} dates set · ${exif} EXIF updates; saved recovery available`, details });
    }
  }
  return { targets: report, historyId, cancelled };
}

module.exports = { modifyPlan, modifyApply, compareStructure, diffItems };

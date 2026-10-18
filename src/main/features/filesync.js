"use strict";

// FileSync
//
// Makes one or more TARGET folders exact clones of a REFERENCE: same files,
// same bytes (so the same EXIF), same creation and modification dates.
//
//   Direct clone  every target gets everything (required with one target).
//   Split clone   the reference's top-level items are shared out across the
//                 targets, each item kept whole, so together the targets hold
//                 one copy of the reference. Items already on a target stay
//                 there; the rest go where there is room.
//
// "Clone all" takes the whole reference; "partial" only the items picked.
// Items that would be overwritten or removed go to the Trash (or, if chosen,
// are deleted to free space on a full external drive).
//
// External drives get special care (see lib/volumes.js): no "._" files on
// exFAT, FAT32's 4 GB limit, coarser timestamps, safe resume after an unplug,
// copies in parallel on SSDs, and the drive's own system folders left alone.

const fs = require("node:fs");
const path = require("node:path");
const { UserError, throttle, mapLimit, filesAtOnce, checkCancel, parentRel, depthOf, newId, isInside, relKey, errText, humanSize } = require("../lib/util");
const { scanTree, childIndex, itemFromStat } = require("../lib/scan");
const { ignoreFor } = require("../lib/ignore");
const { sameContent } = require("../lib/samefile");
const { applyTimes, canSetBirthtime } = require("../lib/filetimes");
const { copyFileExact, diskSpace } = require("../lib/copy");
const { brief, nameProblem, isVolumeSystemItem } = require("../lib/volumes");

const SPACE_MARGIN = 100 * 1000 * 1000; // leave at least 100 MB free on a target

// ---------------------------------------------------------------------------
// Reference tree for the "partial" picker
// ---------------------------------------------------------------------------

function cacheKey(reference, includeAll) {
  return `sync-ref|${path.resolve(reference)}|${includeAll ? 1 : 0}`;
}

async function loadReference(ctx, reference, opts, task, { fresh = false } = {}) {
  let st;
  try {
    st = await fs.promises.stat(reference);
  } catch (err) {
    throw new UserError(`Can't open the reference: ${errText(err)}`);
  }
  if (st.isFile()) {
    const root = path.dirname(reference);
    const name = path.basename(reference);
    const items = new Map();
    const rootItem = itemFromStat("", path.basename(root), root, await fs.promises.stat(root));
    rootItem.kind = "dir";
    items.set("", rootItem);
    items.set(relKey(name), itemFromStat(relKey(name), name, reference, st));
    rootItem.bytes = st.size;
    rootItem.count = 1;
    return { root, name, singleFile: true, items, files: 1, dirs: 0, size: st.size, index: childIndex(items) };
  }
  const key = cacheKey(reference, opts.includeAll);
  const cached = !fresh && ctx.recall(key);
  if (cached && Date.now() - cached.at < 20000) return cached.ref;
  const report = throttle((p) => task.progress(p), 150);
  const scan = await scanTree(reference, {
    ignore: ignoreFor(opts),
    signal: task.signal,
    onProgress: (p) => report({ phase: "scan-reference", scanned: p.scanned }),
  });
  report.flush();
  const ref = {
    root: reference,
    name: path.basename(path.resolve(reference)),
    singleFile: false,
    items: scan.items,
    files: scan.files,
    dirs: scan.dirs - 1,
    size: scan.size,
    errors: scan.errors,
    index: childIndex(scan.items),
  };
  ctx.remember(key, { at: Date.now(), ref });
  return ref;
}

function childList(ref, rel) {
  return (ref.index.get(rel) || []).map((childRel) => {
    const it = ref.items.get(childRel);
    return {
      rel: childRel,
      name: it.name,
      kind: it.kind,
      size: it.kind === "dir" ? it.bytes : it.size,
      count: it.kind === "dir" ? it.count : 0,
      hasChildren: it.kind === "dir" && (ref.index.get(childRel) || []).length > 0,
    };
  });
}

async function referenceTree(ctx, { reference, options = {} }, task) {
  const opts = { includeAll: ctx.settings.get().includeAll, ...options };
  const ref = await loadReference(ctx, reference, opts, task, { fresh: true });
  return {
    path: reference,
    name: ref.singleFile ? ref.name : ref.name,
    singleFile: ref.singleFile,
    files: ref.files,
    dirs: ref.dirs,
    size: ref.size,
    errors: (ref.errors || []).length,
    children: ref.singleFile ? [] : childList(ref, ""),
  };
}

async function referenceChildren(ctx, { reference, rel, options = {} }, task) {
  const opts = { includeAll: ctx.settings.get().includeAll, ...options };
  const ref = await loadReference(ctx, reference, opts, task);
  return childList(ref, rel);
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function makeSelection(selection) {
  if (!selection) return null;
  const chosen = new Set(selection.map((s) => relKey(s)));
  const ancestors = new Set([""]);
  for (const s of chosen) {
    let p = s;
    while (p) {
      p = parentRel(p);
      ancestors.add(p);
    }
  }
  const covered = (rel) => {
    let p = rel;
    while (true) {
      if (chosen.has(p)) return true;
      if (!p) return false;
      p = parentRel(p);
    }
  };
  return {
    // The item is copied (it or a parent was picked) or is a folder on the way to a picked item.
    included: (rel) => covered(rel) || ancestors.has(rel),
    // The item's whole contents are in the selection, so extra items inside it may be removed.
    full: (rel) => covered(rel),
  };
}

function unitOf(rel) {
  const i = rel.indexOf("/");
  return i < 0 ? rel : rel.slice(0, i);
}

// Readable wording for the errors external drives produce.
function friendlyError(err, volume) {
  const text = errText(err);
  if (/No space left|ENOSPC/i.test(text)) return `${volume.name} is full`;
  if (/File too large|EFBIG/i.test(text)) return `too large for a ${volume.fsLabel} drive (4 GB limit)`;
  if (/Invalid argument|Illegal byte sequence|EINVAL|EILSEQ/i.test(text) && volume.restrictNames) return `this name can't be stored on a ${volume.fsLabel} drive`;
  if (/Read-only|EROFS/i.test(text)) return `${volume.name} is read-only`;
  return text;
}

// The target vanished mid-sync: usually an unplugged drive.
class DriveGone extends UserError {
  constructor(volume, target) {
    super(
      volume.mountPoint !== "/" && !fs.existsSync(volume.mountPoint)
        ? `“${volume.name}” was disconnected. Plug it back in and run the sync again: everything already copied is kept, and the next run carries on from there.`
        : `The target folder ${target} no longer exists. Nothing more was changed.`,
    );
  }
}

async function analyze(ctx, { reference, targets, mode = "direct", selection = null, options = {} }, task) {
  const settings = ctx.settings.get();
  const opts = {
    verify: "quick",
    mirror: false,
    strategy: "balance",
    intoSubfolder: false,
    avoidAppleDouble: true, // no "._" files on exFAT/FAT drives
    removeMode: "trash", // or "delete"
    includeAll: settings.includeAll,
    toleranceMs: settings.toleranceMs,
    assignments: {},
    ...options,
  };
  if (!reference) throw new UserError("Choose a reference folder.");
  targets = (targets || []).filter(Boolean);
  if (!targets.length) throw new UserError("Add at least one target folder.");
  if (mode === "split" && targets.length < 2) throw new UserError("Split clone needs at least two targets.");

  // Sanity checks: no target may be the reference, inside it, or contain it.
  const refAbs = path.resolve(reference);
  for (const t of targets) {
    const abs = path.resolve(t);
    let st;
    try {
      st = await fs.promises.stat(abs);
    } catch (err) {
      throw new UserError(`Target ${t} can't be opened: ${errText(err)}. If it's on an external drive, check that the drive is plugged in.`);
    }
    if (!st.isDirectory()) throw new UserError(`Target ${path.basename(t)} is not a folder.`);
    if (abs === refAbs) throw new UserError("A target can't be the reference itself.");
    if (isInside(abs, refAbs)) throw new UserError(`Target ${path.basename(t)} is inside the reference.`);
    if (isInside(refAbs, abs) && !opts.intoSubfolder) throw new UserError(`The reference is inside target ${path.basename(t)}.`);
  }
  for (let i = 0; i < targets.length; i++) {
    for (let j = i + 1; j < targets.length; j++) {
      const a = path.resolve(targets[i]);
      const b = path.resolve(targets[j]);
      if (a === b) throw new UserError("The same target is listed twice.");
      if (isInside(a, b) || isInside(b, a)) throw new UserError("One target is inside another.");
    }
  }

  const ref = await loadReference(ctx, reference, opts, task, { fresh: true });
  if (ref.errors && ref.errors.length) {
    throw new UserError(`${ref.errors.length} item(s) in the reference can't be read. First: ${ref.errors[0].rel} (${ref.errors[0].error})`);
  }
  if (ref.singleFile) {
    selection = [relKey(ref.name)];
    opts.mirror = false;
  }
  const refDev = (await fs.promises.stat(ref.root)).dev;
  const refVolume = await ctx.volumes.info(ref.root);
  const sel = makeSelection(selection);
  const included = (rel) => (sel ? sel.included(rel) : true);
  const full = (rel) => (sel ? sel.full(rel) : true);

  // Items to clone, and which top-level unit each belongs to.
  const refRels = [...ref.items.keys()].filter((rel) => included(rel));
  const units = new Map(); // unit rel -> { rel, name, kind, bytes, files }
  for (const rel of refRels) {
    if (!rel) continue;
    const u = unitOf(rel);
    if (!units.has(u)) {
      const top = ref.items.get(u);
      units.set(u, { rel: u, name: top.name, kind: top.kind, bytes: 0, files: 0 });
    }
    const it = ref.items.get(rel);
    if (it.kind === "file") {
      units.get(u).bytes += it.size;
      units.get(u).files++;
    }
  }
  if (!units.size) throw new UserError(sel ? "Nothing is selected." : "The reference folder is empty.");

  // Read each target and the drive it's on.
  const report = throttle((p) => task.progress(p), 150);
  const tinfo = [];
  for (const [i, t] of targets.entries()) {
    checkCancel(task.signal);
    const root = opts.intoSubfolder && !ref.singleFile ? path.join(t, ref.name) : t;
    if (path.resolve(root) === refAbs || isInside(refAbs, path.resolve(root)) || isInside(path.resolve(root), refAbs)) {
      throw new UserError(`Cloning into ${root} would overlap the reference.`);
    }
    const volume = await ctx.volumes.info(t);
    let items = new Map();
    let exists = true;
    try {
      const st = await fs.promises.stat(root);
      if (!st.isDirectory()) throw new UserError(`${root} exists but is not a folder.`);
    } catch (err) {
      if (err instanceof UserError) throw err;
      exists = false;
    }
    const partials = [];
    if (exists) {
      const scan = await scanTree(root, {
        ignore: ignoreFor(opts),
        signal: task.signal,
        onProgress: (p) => report({ phase: "scan-target", target: path.basename(t) || volume.name, targetIndex: i, scanned: p.scanned }),
        onSkip: (name, abs) => {
          if (name.startsWith(".myfile-partial-")) partials.push(abs);
        },
      });
      items = scan.items;
    }
    const targetDev = (await fs.promises.stat(t)).dev;
    tinfo.push({
      index: i,
      path: t,
      root,
      rootExists: exists,
      items,
      partials,
      volume,
      isVolumeRoot: path.resolve(root) === volume.mountPoint,
      sameDisk: targetDev === refDev,
      tol: Math.max(opts.toleranceMs, volume.granularityMs),
      space: await diskSpace(t),
    });
  }
  report.flush();

  // Decide which target gets which top-level item.
  const assign = new Map(); // unit -> [target indexes]
  const notes = [];
  if (mode !== "split") {
    for (const u of units.keys()) assign.set(u, tinfo.map((t) => t.index));
  } else {
    // Bytes of each unit already present (same size) on each target, in one pass.
    const present = tinfo.map(() => new Map());
    for (const rel of refRels) {
      const r = ref.items.get(rel);
      if (!rel || r.kind !== "file") continue;
      for (const t of tinfo) {
        const x = t.items.get(rel);
        if (x && x.kind === "file" && x.size === r.size) {
          const u = unitOf(rel);
          present[t.index].set(u, (present[t.index].get(u) || 0) + r.size);
        }
      }
    }
    const existing = (u, t) => present[t.index].get(u) || 0;
    const planned = tinfo.map(() => 0);
    const room = (t) => (!t.volume.writable ? -Infinity : t.space.free === null ? Infinity : t.space.free - SPACE_MARGIN - planned[t.index]);
    const pending = [];
    for (const [u, unit] of units) {
      const manual = opts.assignments[u];
      if (Number.isInteger(manual) && tinfo[manual]) {
        assign.set(u, [manual]);
        planned[manual] += unit.bytes - existing(u, tinfo[manual]);
        continue;
      }
      let best = -1;
      let bestBytes = 0;
      for (const t of tinfo) {
        const has = t.items.has(u) ? Math.max(existing(u, t), 1) : 0;
        if (has > bestBytes) {
          best = t.index;
          bestBytes = has;
        }
      }
      if (best >= 0) {
        assign.set(u, [best]);
        planned[best] += unit.bytes - existing(u, tinfo[best]);
      } else pending.push(unit);
    }
    pending.sort((a, b) => b.bytes - a.bytes);
    for (const unit of pending) {
      let choice;
      if (opts.strategy === "fill") choice = tinfo.find((t) => room(t) >= unit.bytes);
      if (!choice) choice = tinfo.reduce((best, t) => (room(t) > room(best) ? t : best), tinfo[0]);
      assign.set(unit.rel, [choice.index]);
      planned[choice.index] += unit.bytes;
      if (room(choice) < 0) notes.push(`${unit.name} (${humanSize(unit.bytes)}) doesn't fit on any target.`);
    }
  }

  // Work out the actions for each target.
  const birthMatters = canSetBirthtime(); // creation dates only count where they can be set (macOS)
  const compareJobs = [];
  for (const t of tinfo) {
    const mine = new Set([...assign].filter(([, list]) => list.includes(t.index)).map(([u]) => u));
    t.units = [...mine];
    t.actions = [];
    t.warnings = [];
    t.stats = { mkdir: 0, copy: 0, copyBytes: 0, replace: 0, replaceBytes: 0, link: 0, touch: 0, remove: 0, removeBytes: 0, unchanged: 0, unchangedBytes: 0, blocked: 0 };
    const tol = t.tol;
    const datesDiffer = (r, x) => (birthMatters && r.kind !== "link" && Math.abs(r.birthMs - x.birthMs) > tol) || Math.abs(r.mtimeMs - x.mtimeMs) > tol;

    for (const rel of refRels) {
      if (rel && !mine.has(unitOf(rel))) continue;
      if (!rel && ref.singleFile) continue;
      const r = ref.items.get(rel);
      const x = t.items.get(rel);
      const base = { rel, kind: r.kind, size: r.kind === "file" ? r.size : 0 };
      if (!x) {
        if (r.kind === "dir") t.actions.push({ op: "mkdir", ...base });
        else if (r.kind === "link") t.actions.push({ op: "link", ...base });
        else if (r.kind === "file") t.actions.push({ op: "copy", ...base });
        continue;
      }
      if (x.kind !== r.kind || (r.kind === "link" && x.linkTarget !== r.linkTarget)) {
        t.actions.push({ op: "replace", ...base, oldKind: x.kind, oldSize: x.kind === "dir" ? x.bytes : x.size, oldPath: x.path, reason: "type" });
        continue;
      }
      if (r.kind === "file") {
        if (x.size !== r.size) {
          t.actions.push({ op: "replace", ...base, oldKind: "file", oldSize: x.size, oldPath: x.path, reason: "size" });
          continue;
        }
        const exactTime = Math.abs(x.mtimeMs - r.mtimeMs) <= Math.max(1, t.volume.granularityMs);
        if (r.size > 0 && (opts.verify === "thorough" || !exactTime)) {
          compareJobs.push({ t, rel, r, x, base });
          continue;
        }
      }
      // The top of an external drive has no dates of its own worth setting.
      if (!rel && t.isVolumeRoot) continue;
      if (datesDiffer(r, x)) t.actions.push({ op: "touch", ...base, reason: "dates" });
      else {
        t.stats.unchanged++;
        t.stats.unchangedBytes += base.size;
      }
    }

    // Mirror: anything in the target that the reference doesn't have. The
    // drive's own system folders (.Spotlight-V100, .Trashes ...) are never touched.
    if (opts.mirror) {
      const removed = new Set();
      const underRemoved = (rel) => {
        for (let p = parentRel(rel); p; p = parentRel(p)) if (removed.has(p)) return true;
        return false;
      };
      for (const [rel, x] of t.items) {
        if (!rel) continue;
        if (underRemoved(rel)) continue;
        if (t.isVolumeRoot && isVolumeSystemItem(rel.split("/")[0])) continue;
        const inRef = ref.items.has(rel) && included(rel);
        const elsewhere = inRef && !mine.has(unitOf(rel));
        const parentFull = full(parentRel(rel));
        if ((!inRef && parentFull && !ref.items.has(rel)) || (elsewhere && full(unitOf(rel)))) {
          t.actions.push({ op: "remove", rel, kind: x.kind, size: x.kind === "dir" ? x.bytes : x.size, oldPath: x.path, reason: elsewhere ? "elsewhere" : "extra" });
          removed.add(rel);
        }
      }
    }
  }

  // Same size but different date (or thorough mode): compare the bytes.
  const totalBytes = compareJobs.reduce((s, j) => s + j.r.size, 0);
  const totalFiles = compareJobs.length;
  let doneBytes = 0;
  let doneFiles = 0;
  // Files being compared right now, oldest first; both drives are read, so the slower one sets the pace.
  const active = new Set();
  const compareLimit = filesAtOnce(settings.parallelFiles, [refVolume, ...new Set(compareJobs.map((j) => j.t.volume))]);
  const sendCompare = () => report({ phase: "compare", doneBytes, totalBytes, doneFiles, totalFiles, active: [...active], current: [...active][0] || null });
  await mapLimit(
    compareJobs,
    compareLimit,
    async (job) => {
      let same = false;
      active.add(job.rel);
      sendCompare();
      try {
        same = await sameContent(job.r.path, job.x.path, {
          signal: task.signal,
          onBytes: (n) => {
            doneBytes += n;
            sendCompare();
          },
        });
      } catch (err) {
        if (err.code === "CANCELLED") throw err;
      } finally {
        active.delete(job.rel);
        doneFiles++;
        sendCompare();
      }
      const tol = job.t.tol;
      if (!same) job.t.actions.push({ op: "replace", ...job.base, oldKind: "file", oldSize: job.x.size, oldPath: job.x.path, reason: "content" });
      else if ((birthMatters && Math.abs(job.r.birthMs - job.x.birthMs) > tol) || Math.abs(job.r.mtimeMs - job.x.mtimeMs) > tol) {
        job.t.actions.push({ op: "touch", ...job.base, reason: "dates" });
      } else {
        job.t.stats.unchanged++;
        job.t.stats.unchangedBytes += job.base.size;
      }
    },
    task.signal,
  );
  report.flush();

  // Drive-specific checks, then totals.
  const order = { remove: 0, replace: 1, mkdir: 2, copy: 3, link: 4, touch: 5 };
  for (const t of tinfo) {
    const v = t.volume;
    const tooBig = [];
    const badNames = [];
    const seenLower = new Map();
    for (const a of t.actions) {
      if ((a.op === "copy" || a.op === "replace") && a.kind === "file" && v.maxFileSize && a.size > v.maxFileSize) {
        a.blocked = `larger than 4 GB, which ${v.fsLabel} can't store`;
        tooBig.push(a.rel);
      }
      if (v.restrictNames && a.op !== "remove" && a.op !== "touch") {
        const name = a.rel.slice(a.rel.lastIndexOf("/") + 1);
        const problem = name && nameProblem(name);
        if (problem) badNames.push(`${a.rel} (${problem})`);
      }
      if (!v.caseSensitive && a.op !== "remove") {
        const lower = a.rel.toLowerCase();
        const other = seenLower.get(lower);
        if (other && other !== a.rel) t.warnings.push(`“${other}” and “${a.rel}” differ only in upper/lower case; this drive treats them as the same name.`);
        seenLower.set(lower, a.rel);
      }
    }
    if (!v.writable) t.blockedReason = v.fsType === "ntfs" ? `${v.name} is formatted NTFS, which macOS can read but not write. Reformat it as exFAT (works with Windows too) or APFS.` : v.volumeWritable ? `You don't have permission to change this folder. Check its permissions in Finder (Get Info › Sharing & Permissions).` : `${v.name} is read-only.`;
    if (tooBig.length) t.warnings.push(`${tooBig.length} file${tooBig.length === 1 ? " is" : "s are"} over 4 GB and can't go on this ${v.fsLabel} drive (e.g. ${tooBig.slice(0, 2).join(", ")}). Reformat it as exFAT or APFS to copy them.`);
    if (badNames.length) t.warnings.push(`${badNames.length} name${badNames.length === 1 ? "" : "s"} may not be allowed on ${v.fsLabel}: ${badNames.slice(0, 3).join(", ")}${badNames.length > 3 ? "…" : ""}`);
    if (!v.xattrs && opts.avoidAppleDouble && t.actions.some((a) => a.op === "copy" || a.op === "replace")) {
      t.info = `${v.fsLabel} can't store Finder tags and other extended attributes, so files are copied without them. That keeps hidden “._” files off the drive.`;
    }
    if (t.partials.length) t.info = `${t.info ? `${t.info} ` : ""}${t.partials.length} unfinished cop${t.partials.length === 1 ? "y" : "ies"} from an interrupted sync will be cleaned up.`;

    t.actions.sort((a, b) => order[a.op] - order[b.op] || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    for (const a of t.actions) {
      if (a.blocked) {
        t.stats.blocked++;
        continue;
      }
      if (a.op === "mkdir") t.stats.mkdir++;
      else if (a.op === "copy") {
        t.stats.copy++;
        t.stats.copyBytes += a.size;
      } else if (a.op === "replace") {
        t.stats.replace++;
        t.stats.replaceBytes += a.size;
      } else if (a.op === "link") t.stats.link++;
      else if (a.op === "touch") t.stats.touch++;
      else if (a.op === "remove") {
        t.stats.remove++;
        t.stats.removeBytes += a.size || 0;
      }
    }
    // Items moved to the Trash still take space on the drive, so the worst
    // case needs all new bytes on top. Deleting frees the replaced bytes.
    t.needBytes = t.stats.copyBytes + t.stats.replaceBytes;
    const freed = opts.removeMode === "delete" ? t.stats.removeBytes + t.actions.filter((a) => a.op === "replace" && !a.blocked).reduce((s, a) => s + (a.oldSize || 0), 0) : 0;
    t.enough = !t.blockedReason && (t.space.free === null || t.needBytes <= Math.max(0, t.space.free + freed - SPACE_MARGIN));
  }

  const plan = {
    id: newId("sync"),
    reference: { path: reference, name: ref.name, singleFile: ref.singleFile, files: ref.files, dirs: ref.dirs, size: ref.size, volume: brief(refVolume) },
    mode,
    partial: Boolean(sel),
    options: opts,
    notes,
    units: [...units.values()].map((u) => ({ ...u, targets: assign.get(u.rel) })),
    targets: tinfo.map((t) => ({
      index: t.index,
      path: t.path,
      // A drive's top level is called by the drive's name, as in Finder ("T7").
      name: t.isVolumeRoot ? t.volume.name : path.basename(t.path) || t.volume.name,
      root: t.root,
      rootExists: t.rootExists,
      space: t.space,
      volume: { ...brief(t.volume), fsType: t.volume.fsType, ejectable: t.volume.ejectable, isVolumeRoot: t.isVolumeRoot },
      units: t.units,
      stats: t.stats,
      needBytes: t.needBytes,
      enough: t.enough,
      blockedReason: t.blockedReason || null,
      warnings: t.warnings,
      info: t.info || null,
      actions: t.actions,
      inSync: t.actions.filter((a) => !a.blocked).length === 0 && !t.partials.length,
    })),
  };
  plan.allEnough = plan.targets.every((t) => t.enough);
  plan.inSync = plan.targets.every((t) => t.inSync);
  ctx.remember(plan.id, { plan, ref, included: refRels, tinfo });
  return plan;
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

function partialName(name) {
  const base = `.myfile-partial-${Math.random().toString(36).slice(2, 8)}-`;
  // Keep the name under the usual 255-byte limit.
  let tail = name;
  while (Buffer.byteLength(base + tail) > 250) tail = tail.slice(1);
  return base + tail;
}

async function run(ctx, { planId }, task) {
  const saved = ctx.recall(planId);
  if (!saved) throw new UserError("This plan is out of date. Analyze again.");
  const { plan, ref, included, tinfo } = saved;
  const opts = plan.options;
  const startedAt = Date.now();
  const totalBytes = plan.targets.reduce((s, t) => s + t.needBytes, 0);
  const totalFiles = plan.targets.reduce((s, t) => s + t.stats.copy + t.stats.replace, 0);
  let doneBytes = 0;
  let doneFiles = 0;
  // Files being copied right now (several at once), oldest first.
  const active = new Set();
  let peakAtOnce = 0;
  const report = throttle((p) => task.progress({ doneBytes, totalBytes, doneFiles, totalFiles, active: [...active], ...p }), 120);
  const results = [];
  // Long copies to an external drive shouldn't stop because the Mac dozes off.
  const release = ctx.keepAwake ? ctx.keepAwake() : null;
  const removeItem = opts.removeMode === "delete" ? (p) => fs.promises.rm(p, { recursive: true, force: true }) : (p) => ctx.trash(p);

  // "Finish current files, then stop": nothing new starts, files in progress finish.
  const softStopped = () => Boolean(task.softSignal && task.softSignal.aborted);
  let stopped = false;
  try {
    for (const t of plan.targets) {
      checkCancel(task.signal);
      if (softStopped()) {
        stopped = true;
        break;
      }
      const info = tinfo[t.index];
      const volume = info.volume;
      const res = {
        index: t.index,
        path: t.path,
        name: t.name,
        root: t.root,
        volume: t.volume,
        bytesWritten: 0,
        copied: 0,
        replaced: 0,
        created: 0,
        linked: 0,
        touched: 0,
        removed: 0,
        skipped: 0,
        errors: [],
        spaceBefore: await diskSpace(t.path),
      };
      results.push(res);
      const abs = (rel) => (rel ? path.join(t.root, ...rel.split("/").map((part, i, arr) => originalName(ref, arr.slice(0, i + 1).join("/"), part))) : t.root);
      // If the drive was unplugged, stop instead of reporting every file as failed.
      const driveThere = () => fs.existsSync(t.path);
      const fail = (rel, err) => {
        if (!driveThere()) throw new DriveGone(volume, t.path);
        res.errors.push({ rel: rel || ".", error: friendlyError(err, volume) });
      };
      const unitSet = new Set(t.units);
      if (t.blockedReason) {
        res.errors.push({ rel: ".", error: t.blockedReason });
        continue;
      }
      if (!driveThere()) throw new DriveGone(volume, t.path);

      // Folders are created one level at a time (never "mkdir -p"), so an
      // unplugged drive can't leave a stray folder behind in /Volumes.
      if (!t.rootExists) await fs.promises.mkdir(t.root);
      for (const p of info.partials) await fs.promises.rm(p, { force: true }).catch(() => {});

      // 1. Remove extras, items whose type changed and outdated symlinks.
      for (const a of t.actions) {
        const swap = a.op === "replace" && (a.oldKind !== a.kind || a.kind === "link");
        if (a.op !== "remove" && !swap) continue;
        checkCancel(task.signal);
        report({ phase: "remove", target: t.name, targetIndex: t.index, current: a.rel });
        try {
          await removeItem(a.oldPath);
          if (a.op === "remove") res.removed++;
        } catch (err) {
          fail(a.rel, err);
        }
      }

      // 2. Folders, shallowest first.
      const dirs = t.actions.filter((a) => a.op === "mkdir" || (a.op === "replace" && a.kind === "dir"));
      dirs.sort((a, b) => depthOf(a.rel) - depthOf(b.rel));
      for (const a of dirs) {
        checkCancel(task.signal);
        try {
          await fs.promises.mkdir(abs(a.rel));
          res.created++;
        } catch (err) {
          if (err.code !== "EEXIST") fail(a.rel, err);
        }
      }

      // 3. Files, through a temporary name so an interrupted copy never looks
      // finished. Each file gets its modification date right away, so if the
      // drive is unplugged the next run recognises what's already done.
      const files = t.actions.filter((a) => (a.op === "copy" || a.op === "replace") && a.kind === "file");
      const finished = new Set();
      await mapLimit(
        files,
        filesAtOnce(ctx.settings.get().parallelFiles, [volume]),
        async (a) => {
          if (a.blocked) {
            res.skipped++;
            res.errors.push({ rel: a.rel, error: a.blocked });
            return;
          }
          const r = ref.items.get(a.rel);
          const dest = abs(a.rel);
          const tmp = path.join(path.dirname(dest), partialName(path.basename(dest)));
          let counted = 0;
          active.add(a.rel);
          peakAtOnce = Math.max(peakAtOnce, active.size);
          report({ phase: "copy", target: t.name, targetIndex: t.index, current: a.rel });
          try {
            await copyFileExact(r.path, tmp, {
              signal: task.signal,
              size: r.size,
              clone: info.sameDisk,
              xattrs: volume.xattrs || !opts.avoidAppleDouble,
              onBytes: (n) => {
                counted += n;
                doneBytes += n;
                report({ phase: "copy", target: t.name, targetIndex: t.index, current: a.rel });
              },
            });
            if (a.op === "replace" && a.oldKind === "file") {
              try {
                await removeItem(a.oldPath);
              } catch (err) {
                throw new Error(`couldn't move the old version ${opts.removeMode === "delete" ? "away" : "to the Trash"} (${errText(err)})`);
              }
            }
            await fs.promises.rename(tmp, dest);
            await fs.promises.utimes(dest, r.atimeMs / 1000, r.mtimeMs / 1000).catch(() => {});
            res.bytesWritten += r.size;
            finished.add(a.rel);
            if (a.op === "copy") res.copied++;
            else res.replaced++;
          } catch (err) {
            await fs.promises.rm(tmp, { force: true }).catch(() => {});
            doneBytes -= counted;
            if (err.code === "CANCELLED" || (task.signal && task.signal.aborted)) throw err;
            fail(a.rel, err);
          } finally {
            active.delete(a.rel);
          }
          doneFiles++;
          report({ phase: "copy", target: t.name, targetIndex: t.index, current: [...active][0] || a.rel });
        },
        task.signal,
        softStopped,
      );
      // Files that were never started (or were blocked/failed) are not touched below.
      const notDone = new Set();
      if (softStopped()) {
        stopped = true;
        res.stopped = true;
        for (const a of files) if (!finished.has(a.rel)) notDone.add(a.rel);
      }

      // 4. Symlinks.
      for (const a of t.actions) {
        if (res.stopped) break;
        if (a.kind !== "link" || (a.op !== "link" && a.op !== "replace")) continue;
        try {
          await fs.promises.symlink(ref.items.get(a.rel).linkTarget, abs(a.rel));
          res.linked++;
        } catch (err) {
          fail(a.rel, err);
        }
      }

      // 5. Dates: every copied, replaced or touched item, plus every folder in
      // the cloned set (copying into a folder changes its modification date).
      // The top of a drive keeps its own dates.
      report({ phase: "dates", target: t.name, targetIndex: t.index, current: null });
      const failedRels = new Set(res.errors.map((e) => e.rel));
      const timeRels = new Set();
      for (const a of t.actions) {
        if (a.op === "remove" || a.blocked || failedRels.has(a.rel) || notDone.has(a.rel)) continue;
        timeRels.add(a.rel);
        if (a.op === "touch") res.touched++;
      }
      for (const rel of included) {
        if (rel && !unitSet.has(unitOf(rel))) continue;
        if (!rel && ref.singleFile) continue;
        if (ref.items.get(rel).kind === "dir") timeRels.add(rel);
      }
      if (info.isVolumeRoot) timeRels.delete("");
      const entries = [...timeRels].map((rel) => {
        const r = ref.items.get(rel);
        return { path: abs(rel), birthMs: r.birthMs, mtimeMs: r.mtimeMs, atimeMs: r.atimeMs, isLink: r.kind === "link" };
      });
      const timeRes = await applyTimes(entries, { signal: task.signal });
      if (timeRes.failures.length && !driveThere()) throw new DriveGone(volume, t.path);
      for (const f of timeRes.failures) res.errors.push({ rel: path.relative(t.root, f.path) || ".", error: f.error });
      res.birthUnsupported = timeRes.birthUnsupported;

      // 6. Check the result.
      // A stopped sync isn't complete, so there is nothing to verify yet.
      if (!res.stopped) {
        report({ phase: "verify", target: t.name, targetIndex: t.index, current: null });
        res.verify = await verifyTarget(ref, t, included, { ...plan.options, toleranceMs: info.tol, skipRoot: info.isVolumeRoot }, task.signal);
      }
      res.spaceAfter = await diskSpace(t.path);
      res.spaceUsed = res.spaceBefore.free !== null && res.spaceAfter.free !== null ? res.spaceBefore.free - res.spaceAfter.free : null;
      // Same APFS disk as the reference: copies are clones that share its storage.
      const refVol = plan.reference.volume;
      res.cloned = Boolean(res.bytesWritten > 0 && volume.fsType === "apfs" && refVol && refVol.mountPoint === volume.mountPoint);
      if (stopped) break;
    }
  } finally {
    if (release) release();
  }
  report.flush();

  const summary = {
    planId,
    startedAt,
    finishedAt: Date.now(),
    elapsedMs: Date.now() - startedAt,
    mode: plan.mode,
    reference: plan.reference,
    targets: results,
    bytesWritten: results.reduce((s, r) => s + r.bytesWritten, 0),
    spaceUsed: results.reduce((s, r) => s + (r.spaceUsed || 0), 0),
    errors: results.reduce((s, r) => s + r.errors.length, 0),
    stopped,
    peakAtOnce,
    filesRemaining: stopped ? Math.max(0, totalFiles - doneFiles) : 0,
    bytesRemaining: stopped ? Math.max(0, totalBytes - doneBytes) : 0,
    totalFiles,
    totalBytes,
  };
  ctx.history.add({
    type: "filesync",
    title: `${plan.mode === "split" ? "Split" : "Synced"} ${plan.reference.name} → ${results.length} target${results.length === 1 ? "" : "s"}`,
    summary: `${stopped ? `Stopped early: ${summary.totalFiles - summary.filesRemaining} of ${summary.totalFiles} files done · ` : ""}${humanSize(summary.bytesWritten)} written · ${results.reduce((s, r) => s + r.copied + r.replaced, 0)} files copied · ${summary.errors} problem${summary.errors === 1 ? "" : "s"}`,
    details: { reference: plan.reference.path, targets: results.map((r) => ({ path: r.path, bytesWritten: r.bytesWritten, spaceUsed: r.spaceUsed, errors: r.errors.length })) },
  });
  return summary;
}

// Paths in the target use the reference's spelling of each name (the
// relative keys are NFC-normalised, the real names may not be).
function originalName(ref, rel, fallback) {
  const it = ref.items.get(rel);
  return it ? it.name : fallback;
}

async function verifyTarget(ref, t, included, opts, signal) {
  let scan;
  try {
    scan = await scanTree(t.root, { ignore: ignoreFor(opts), signal });
  } catch (err) {
    if (err.code === "CANCELLED") throw err;
    return { checked: 0, mismatches: null, sample: [errText(err)] };
  }
  const units = new Set(t.units);
  const blocked = new Set(t.actions.filter((a) => a.blocked).map((a) => a.rel));
  const tol = Math.max(opts.toleranceMs, 2000);
  let checked = 0;
  const sample = [];
  let mismatches = 0;
  for (const rel of included) {
    if (rel && !units.has(unitOf(rel))) continue;
    if (!rel) continue;
    const r = ref.items.get(rel);
    const x = scan.items.get(rel);
    if (blocked.has(rel)) continue;
    checked++;
    let problem = null;
    if (!x) problem = "missing";
    else if (x.kind !== r.kind) problem = "wrong type";
    else if (r.kind === "file" && x.size !== r.size) problem = "size differs";
    else if (Math.abs(x.mtimeMs - r.mtimeMs) > tol) problem = "modified date differs";
    else if (r.kind !== "link" && canSetBirthtime() && Math.abs(x.birthMs - r.birthMs) > tol) problem = "created date differs";
    if (problem) {
      mismatches++;
      if (sample.length < 20) sample.push(`${rel}: ${problem}`);
    }
  }
  return { checked, mismatches, sample };
}

/** Ejects the external drive a finished sync wrote to. */
async function eject(ctx, { path: p }) {
  const v = await ctx.volumes.info(p);
  if (!v.ejectable && !v.external) throw new UserError(`${v.name} isn't an external drive.`);
  await ctx.volumes.eject(v.mountPoint);
  return { name: v.name };
}

module.exports = { referenceTree, referenceChildren, analyze, run, eject, makeSelection };

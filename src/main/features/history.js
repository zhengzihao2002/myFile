"use strict";

// History › Undo: puts back the EXIF tags and file dates an operation changed.

const { UserError } = require("../lib/util");
const { applyTimes } = require("../lib/filetimes");
const fs = require("node:fs");

async function revert(ctx, { id }, task) {
  const entry = ctx.history.list().find((e) => e.id === id);
  if (!entry) throw new UserError("That history entry no longer exists.");
  if (entry.reverted) throw new UserError("This was already undone.");
  const undo = ctx.history.getUndo(id);
  if (!undo) throw new UserError("There is nothing to undo for this entry.");

  const failures = [];
  const pending = { exif: [...(undo.exif || [])], times: [...(undo.times || [])] };
  // Older history entries did not label directories. Retain their recovery
  // dates too whenever a pending EXIF retry may touch files inside them.
  for (const item of pending.times) {
    if (item.dir !== undefined) continue;
    try { item.dir = (await fs.promises.lstat(item.path)).isDirectory(); } catch { /* retry the missing path below */ }
  }
  let restored = 0;
  let birthUnsupported = 0;
  let cancelled = false;
  const failedExif = new Set();
  const persist = () => ctx.history.setUndoRemaining(id, pending, { failures: failures.length, cancelled, at: Date.now() });
  const stopped = () => Boolean(task.signal && task.signal.aborted);
  // Checkpoint after every successful item. If the process is interrupted
  // during a write, that item's original snapshot stays available for retry.
  for (const item of [...pending.exif]) {
    if (stopped()) { cancelled = true; break; }
    task.progress({ phase: "exif", done: restored, total: undo.exif.length, current: item.path });
    try {
      if (item.tags && item.tags.length) await ctx.et.write(item.path, item.tags, { signal: task.signal });
      pending.exif = pending.exif.filter((x) => x !== item);
      restored++;
      persist();
    } catch (err) {
      failedExif.add(item.path);
      if (err.code === "CANCELLED" || stopped()) { cancelled = true; break; }
      failures.push({ path: item.path, error: `EXIF: ${err.message}` });
    }
  }
  const waitingExif = new Set(pending.exif.map((x) => x.path));
  // File dates follow EXIF. A file whose EXIF restoration failed must retain
  // its date snapshot too, since retrying EXIF may change those dates again.
  const eligibleTimes = pending.times.filter((item) => !item.dir && !waitingExif.has(item.path) && !failedExif.has(item.path));
  if (stopped()) cancelled = true;
  else if (eligibleTimes.length) {
    task.progress({ phase: "dates", done: 0, total: eligibleTimes.length });
    try {
      const res = await applyTimes(eligibleTimes, { signal: task.signal, onProgress: (p) => task.progress({ ...p, phase: "dates" }) });
      birthUnsupported += res.birthUnsupported;
      failures.push(...res.failures);
      const failed = new Set(res.failures.map((item) => item.path));
      const completed = new Set(eligibleTimes.filter((item) => !failed.has(item.path)));
      restored += completed.size;
      pending.times = pending.times.filter((item) => !completed.has(item));
      persist();
    } catch (err) {
      // A cancelled batch can contain unconfirmed partial date writes. Keep
      // those date snapshots for retry; successful EXIF work stays checkpointed.
      if (err.code === "CANCELLED" || stopped()) cancelled = true;
      else failures.push(...eligibleTimes.map((item) => ({ path: item.path, error: err.message })));
    }
  }
  // Protect folder dates even after Cancel. Retain their snapshots while any
  // file is pending, so a later retry can put them back after its EXIF writes.
  const filesPending = pending.exif.length || pending.times.some((x) => !x.dir);
  const directories = pending.times.filter((item) => item.dir);
  if (directories.length) {
    const res = await applyTimes(directories);
    failures.push(...res.failures);
    if (!filesPending) {
      const failed = new Set(res.failures.map((item) => item.path));
      const completed = new Set(directories.filter((item) => !failed.has(item.path)));
      restored += completed.size;
      pending.times = pending.times.filter((item) => !completed.has(item));
      persist();
    }
  }
  const remaining = pending.exif.length + pending.times.length;
  if (remaining) persist();
  else ctx.history.markReverted(id, { failures: 0, at: Date.now() });
  return { restored, failures, birthUnsupported, pending: remaining, cancelled };
}

module.exports = { revert };

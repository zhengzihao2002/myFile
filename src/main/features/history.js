"use strict";

// History › Undo: puts back the EXIF tags and file dates an operation changed.

const { UserError, checkCancel } = require("../lib/util");
const { applyTimes } = require("../lib/filetimes");

async function revert(ctx, { id }, task) {
  const entry = ctx.history.list().find((e) => e.id === id);
  if (!entry) throw new UserError("That history entry no longer exists.");
  if (entry.reverted) throw new UserError("This was already undone.");
  const undo = ctx.history.getUndo(id);
  if (!undo) throw new UserError("There is nothing to undo for this entry.");

  const failures = [];
  const exif = undo.exif || [];
  let done = 0;
  // EXIF first: writing tags touches the file, the dates are restored after.
  for (const item of exif) {
    checkCancel(task.signal);
    task.progress({ phase: "exif", done, total: exif.length, current: item.path });
    done++;
    if (!item.tags || !item.tags.length) continue;
    try {
      await ctx.et.write(item.path, item.tags, { signal: task.signal });
    } catch (err) {
      if (err.code === "CANCELLED") throw err;
      failures.push({ path: item.path, error: `EXIF: ${err.message}` });
    }
  }
  const times = (undo.times || []).map((t) => ({
    path: t.path,
    birthMs: t.birthMs,
    mtimeMs: t.mtimeMs,
    atimeMs: t.atimeMs,
    isLink: t.isLink,
  }));
  task.progress({ phase: "dates", done: 0, total: times.length });
  const res = await applyTimes(times, { signal: task.signal });
  failures.push(...res.failures);
  const restored = exif.length + times.length;
  ctx.history.markReverted(id, { failures: failures.length, at: Date.now() });
  return { restored, failures, birthUnsupported: res.birthUnsupported };
}

module.exports = { revert };

"use strict";

// EXIF › Modify › Use each file's own date
//
// Reads the date a photo or video was taken from its own metadata and sets
// the file's creation and modification dates (what Finder shows) to it.

const fs = require("node:fs");
const path = require("node:path");
const { checkCancel } = require("../lib/util");
const { expandMediaPaths } = require("../lib/media");
const { bestDate, momentText } = require("../lib/dates");
const { applyTimes, canSetBirthtime } = require("../lib/filetimes");
const { ignoreFor } = require("../lib/ignore");
const { isMovieFile } = require("./exif-copy");

const READ_ARGS = ["-G0:1", "-a", "-s", "-time:all"];

async function selfDatePlan(ctx, { paths, options = {} }, task) {
  const opts = { created: true, modified: true, toleranceMs: ctx.settings.get().toleranceMs, ...options };
  const { files, skipped } = await expandMediaPaths(paths || [], {
    ignore: ignoreFor(opts),
    signal: task.signal,
    onProgress: ({ found, current }) => task.progress({ phase: "find", found, current }),
  });

  const rows = [];
  for (let i = 0; i < files.length; i += 100) {
    checkCancel(task.signal);
    const chunk = files.slice(i, i + 100);
    const data = await ctx.et.readJson(chunk, READ_ARGS, { signal: task.signal });
    const bySource = new Map(data.map((r) => [String(r.SourceFile).normalize("NFC"), r]));
    for (const file of chunk) {
      const tags = bySource.get(file.normalize("NFC")) || {};
      const st = await fs.promises.lstat(file);
      const found = bestDate(tags, { movie: isMovieFile(file) });
      const row = {
        path: file,
        name: path.basename(file),
        folder: path.dirname(file),
        createdMs: st.birthtimeMs,
        modifiedMs: st.mtimeMs,
        exifText: found ? momentText(found.moment) : "",
        source: found ? found.source : null,
        targetMs: found ? found.moment.ms : null,
      };
      if (!found) row.status = "nodate";
      else {
        const tol = opts.toleranceMs;
        const createdOff = opts.created && canSetBirthtime() && Math.abs(st.birthtimeMs - row.targetMs) > tol;
        const modifiedOff = opts.modified && Math.abs(st.mtimeMs - row.targetMs) > tol;
        row.changeCreated = createdOff;
        row.changeModified = modifiedOff;
        row.status = createdOff || modifiedOff ? "change" : "same";
      }
      rows.push(row);
    }
    task.progress({ phase: "read", done: Math.min(i + 100, files.length), total: files.length, current: path.basename(chunk[chunk.length - 1].path || chunk[chunk.length - 1]) });
  }

  const counts = { change: 0, same: 0, nodate: 0 };
  for (const r of rows) counts[r.status]++;
  return { rows, counts, skipped, options: opts };
}

async function selfDateApply(ctx, { paths, options = {} }, task) {
  const plan = await selfDatePlan(ctx, { paths, options }, task);
  const opts = plan.options;
  const todo = plan.rows.filter((r) => r.status === "change");
  const undo = todo.map((r) => ({ path: r.path, birthMs: r.createdMs, mtimeMs: r.modifiedMs }));
  const entries = todo.map((r) => ({
    path: r.path,
    mtimeMs: opts.modified ? r.targetMs : undefined,
    birthMs: opts.created ? r.targetMs : undefined,
  }));
  task.progress({ phase: "apply", done: 0, total: entries.length });
  const res = await applyTimes(entries, {
    signal: task.signal,
    onProgress: (p) => task.progress({ phase: "apply", ...p }),
  });
  const failed = new Set(res.failures.map((f) => f.path));
  const changed = todo.filter((r) => !failed.has(r.path)).length;

  let historyId = null;
  if (todo.length) {
    const entry = ctx.history.add({
      type: "exif-dates",
      title: "Set file dates from EXIF",
      summary: `${changed} file${changed === 1 ? "" : "s"} updated, ${plan.counts.same} already matched, ${plan.counts.nodate} without a date`,
      details: { paths, options: opts },
      undo: { times: undo.filter((u) => !failed.has(u.path)) },
    });
    historyId = entry.id;
  }
  return {
    changed,
    failures: res.failures,
    birthUnsupported: res.birthUnsupported,
    counts: plan.counts,
    historyId,
  };
}

module.exports = { selfDatePlan, selfDateApply };

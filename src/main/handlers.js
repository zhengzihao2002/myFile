"use strict";

// Every operation the window can ask for, by name. Nothing here depends on
// Electron: main.js connects these to IPC, and the test harness to HTTP.
// Each handler gets (payload, task), where task = { signal, progress(obj) }.

const fs = require("node:fs");
const path = require("node:path");
const { Settings, History } = require("./lib/store");
const { UserError } = require("./lib/util");
const { mediaKind, BROWSER_IMAGE } = require("./lib/media");
const { extOf } = require("./lib/util");
const filetimes = require("./lib/filetimes");
const volumes = require("./lib/volumes");
const exifShow = require("./features/exif-show");
const exifCopy = require("./features/exif-copy");
const exifDates = require("./features/exif-dates");
const folderCompare = require("./features/folder-compare");
const folderModify = require("./features/folder-modify");
const folderIndex = require("./features/folder-index");
const filesync = require("./features/filesync");
const history = require("./features/history");

function createContext({ runtime, et, trash, fileUrl, appVersion, extraInfo = {}, keepAwake = null, volumeInfo = volumes }) {
  filetimes.configure({ tmpDir: runtime.tmpDir });
  const memory = new Map();
  return {
    runtime,
    et,
    trash,
    fileUrl,
    appVersion,
    extraInfo,
    // Facts about the drive a path is on (format, external, SSD ...).
    volumes: volumeInfo,
    // Returns a function that lets the Mac sleep again.
    keepAwake,
    settings: new Settings(runtime.dataDir),
    history: new History(runtime.dataDir),
    // Plans and results kept between "check" and "apply" (newest 16).
    remember(id, value) {
      memory.delete(id);
      memory.set(id, value);
      while (memory.size > 16) memory.delete(memory.keys().next().value);
    },
    recall(id) {
      return memory.get(id);
    },
  };
}

function dirSize(dir) {
  let total = 0;
  const walk = (p) => {
    let entries;
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else {
        try {
          total += fs.lstatSync(full).size;
        } catch {
          // ignore
        }
      }
    }
  };
  walk(dir);
  return total;
}

function createHandlers(ctx) {
  const wrap = (fn) => (payload, task) => fn(ctx, payload || {}, task);
  return {
    "app.info": async () => ({
      version: ctx.appVersion,
      platform: process.platform,
      arch: process.arch,
      dataDir: ctx.runtime.dataDir,
      ephemeral: ctx.runtime.ephemeral,
      projectRoot: ctx.runtime.projectRoot,
      perl: ctx.runtime.perl,
      exiftool: ctx.runtime.exiftool,
      exiftoolVersion: await ctx.et.getVersion().catch(() => null),
      canSetCreationDate: filetimes.canSetBirthtime(),
      versions: { node: process.versions.node, electron: process.versions.electron || null, chrome: process.versions.chrome || null },
      ...ctx.extraInfo,
    }),

    "settings.get": async () => ctx.settings.get(),
    "settings.set": async (patch) => ctx.settings.set(patch),

    // Basic facts about dropped or chosen paths, for the drop zones.
    "paths.inspect": async ({ paths }) =>
      Promise.all(
        (paths || []).map(async (p) => {
          try {
            const st = await fs.promises.stat(p);
            const info = {
              path: p,
              name: path.basename(p) || p,
              exists: true,
              isDir: st.isDirectory(),
              isFile: st.isFile(),
              size: st.isFile() ? st.size : null,
              createdMs: st.birthtimeMs,
              modifiedMs: st.mtimeMs,
              media: st.isFile() ? mediaKind(p) : null,
              isHtml: st.isFile() && /\.html?$/i.test(p),
            };
            // Photos the window can show directly get a URL for thumbnails.
            if (info.media === "image" && BROWSER_IMAGE.has(extOf(p))) info.url = ctx.fileUrl(p);
            if (st.isDirectory()) {
              try {
                info.entries = (await fs.promises.readdir(p)).filter((n) => !n.startsWith(".")).length;
              } catch {
                info.entries = null;
              }
              // Folders on external drives show which drive they're on.
              const v = await ctx.volumes.info(p).catch(() => null);
              if (v && v.external) info.volume = volumes.brief(v);
            }
            return info;
          } catch {
            return { path: p, name: path.basename(p) || p, exists: false };
          }
        }),
      ),

    "exif.inspect": wrap(exifShow.inspect),
    "exif.preview": wrap(exifShow.preview),
    "exif.poster": wrap(exifShow.poster),
    "exif.copyPlan": wrap(exifCopy.copyPlan),
    "exif.copyApply": wrap(exifCopy.copyApply),
    "exif.datesPlan": wrap(exifDates.selfDatePlan),
    "exif.datesApply": wrap(exifDates.selfDateApply),

    "folder.compare": wrap(folderCompare.compare),
    "folder.compareExport": wrap(folderCompare.compareExport),
    "folder.modifyPlan": wrap(folderModify.modifyPlan),
    "folder.modifyApply": wrap(folderModify.modifyApply),
    "folder.index": wrap(folderIndex.generateIndex),
    "folder.indexInfo": async ({ path: file }) => {
      const index = await folderIndex.readIndexFile(file);
      return {
        path: file,
        name: index.name,
        root: index.root,
        kind: index.kind,
        generatedAt: index.generatedAt,
        hasExif: Boolean(index.options && index.options.exif),
        stats: index.stats || null,
      };
    },

    "sync.tree": wrap(filesync.referenceTree),
    "sync.children": wrap(filesync.referenceChildren),
    "sync.analyze": wrap(filesync.analyze),
    "sync.run": wrap(filesync.run),
    "sync.eject": wrap(filesync.eject),

    "history.list": async () => ctx.history.list(),
    "history.revert": wrap(history.revert),
    "history.remove": async ({ id }) => {
      ctx.history.remove(id);
      return ctx.history.list();
    },
    "history.clear": async () => {
      ctx.history.clear();
      return [];
    },

    "data.usage": async () => ({ dataDir: ctx.runtime.dataDir, bytes: dirSize(ctx.runtime.dataDir) }),
    "data.clearPreviews": async () => {
      fs.rmSync(ctx.runtime.previewDir, { recursive: true, force: true });
      fs.rmSync(ctx.runtime.tmpDir, { recursive: true, force: true });
      return { dataDir: ctx.runtime.dataDir, bytes: dirSize(ctx.runtime.dataDir) };
    },
  };
}

/** Runs a handler and turns any error into { ok:false, error } for the window. */
async function invoke(handlers, name, payload, task) {
  const fn = handlers[name];
  if (!fn) return { ok: false, error: `Unknown action: ${name}` };
  try {
    return { ok: true, result: await fn(payload, task) };
  } catch (err) {
    if (err && err.code === "CANCELLED") return { ok: false, cancelled: true, error: "Cancelled" };
    const user = err instanceof UserError || (err && err.code === "USER");
    if (!user) console.error(`[${name}]`, err);
    return { ok: false, error: err && err.message ? err.message : String(err), details: err && err.details };
  }
}

module.exports = { createContext, createHandlers, invoke };

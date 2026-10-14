"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { checkCancel, relKey, joinRel, parentRel, depthOf, errText, UserError } = require("./util");

function kindOf(st) {
  if (st.isSymbolicLink()) return "link";
  if (st.isDirectory()) return "dir";
  if (st.isFile()) return "file";
  return "other";
}

function itemFromStat(rel, name, absPath, st) {
  return {
    rel,
    name,
    path: absPath,
    kind: kindOf(st),
    depth: depthOf(rel),
    size: st.isFile() ? st.size : 0,
    birthMs: st.birthtimeMs,
    mtimeMs: st.mtimeMs,
    atimeMs: st.atimeMs,
  };
}

/**
 * Reads a folder tree. Every item (the root itself included, as rel "") ends up
 * in `items`, keyed by its "/"-separated NFC relative path. Folders get
 * `bytes` (total size below) and `count` (items below) once the walk is done.
 * Symlinks are recorded, never followed. Ignored names are reported to
 * onSkip(name, absPath, parentRel) instead.
 */
async function scanTree(root, { ignore = () => false, signal, onProgress, onSkip, concurrency = 16 } = {}) {
  let rootStat;
  try {
    rootStat = await fs.promises.stat(root);
  } catch (err) {
    throw new UserError(`Can't read ${root}: ${errText(err)}`);
  }
  if (!rootStat.isDirectory()) throw new UserError(`${root} is not a folder.`);

  const result = {
    root,
    items: new Map(),
    dirs: 0,
    files: 0,
    links: 0,
    skipped: 0,
    size: 0,
    errors: [],
  };
  const rootItem = itemFromStat("", path.basename(root) || root, root, rootStat);
  rootItem.kind = "dir";
  result.items.set("", rootItem);
  result.dirs = 1;

  let seen = 0;
  const report = () => {
    seen++;
    if (onProgress && seen % 250 === 0) onProgress({ scanned: seen, current: null });
  };

  const queue = [rootItem];
  let active = 0;

  await new Promise((resolve, reject) => {
    let failed = false;
    const pump = () => {
      if (failed) return;
      if (signal && signal.aborted) {
        failed = true;
        try {
          checkCancel(signal);
        } catch (err) {
          reject(err);
        }
        return;
      }
      while (active < concurrency && queue.length) {
        const dir = queue.shift();
        active++;
        readDir(dir)
          .then(() => {
            active--;
            if (!queue.length && active === 0) resolve();
            else pump();
          })
          .catch((err) => {
            failed = true;
            reject(err);
          });
      }
      if (!queue.length && active === 0) resolve();
    };

    const readDir = async (dir) => {
      let entries;
      try {
        entries = await fs.promises.readdir(dir.path, { withFileTypes: true });
      } catch (err) {
        dir.error = errText(err);
        result.errors.push({ rel: dir.rel, path: dir.path, error: dir.error });
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const stats = await Promise.all(
        entries.map(async (entry) => {
          if (ignore(entry.name)) {
            result.skipped++;
            if (onSkip) onSkip(entry.name, path.join(dir.path, entry.name), dir.rel);
            return null;
          }
          const abs = path.join(dir.path, entry.name);
          try {
            return [entry, abs, await fs.promises.lstat(abs)];
          } catch (err) {
            result.errors.push({ rel: joinRel(dir.rel, relKey(entry.name)), path: abs, error: errText(err) });
            return null;
          }
        }),
      );
      for (const found of stats) {
        if (!found) continue;
        const [entry, abs, st] = found;
        const name = relKey(entry.name);
        const rel = joinRel(dir.rel, name);
        const item = itemFromStat(rel, entry.name, abs, st);
        if (item.kind === "link") {
          try {
            item.linkTarget = await fs.promises.readlink(abs);
          } catch {
            item.linkTarget = null;
          }
          result.links++;
        } else if (item.kind === "dir") {
          result.dirs++;
          queue.push(item);
        } else if (item.kind === "file") {
          result.files++;
          result.size += item.size;
        }
        result.items.set(rel, item);
        report();
      }
    };

    pump();
  });

  aggregate(result.items);
  if (onProgress) onProgress({ scanned: result.items.size, current: null, done: true });
  return result;
}

// Fills in folder totals: bytes below and number of items below.
function aggregate(items) {
  const dirs = [];
  for (const item of items.values()) {
    if (item.kind === "dir") {
      item.bytes = 0;
      item.count = 0;
      dirs.push(item);
    }
  }
  const sorted = [...items.values()].sort((a, b) => b.depth - a.depth);
  for (const item of sorted) {
    if (!item.rel) continue;
    const parent = items.get(parentRel(item.rel));
    if (!parent) continue;
    parent.count += 1 + (item.kind === "dir" ? item.count : 0);
    parent.bytes += item.kind === "dir" ? item.bytes : item.size;
  }
}

// Map of folder rel -> sorted child rels.
function childIndex(items) {
  const index = new Map();
  for (const item of items.values()) {
    if (!item.rel) continue;
    const parent = parentRel(item.rel);
    if (!index.has(parent)) index.set(parent, []);
    index.get(parent).push(item.rel);
  }
  for (const list of index.values()) list.sort();
  return index;
}

module.exports = { scanTree, aggregate, childIndex, itemFromStat };

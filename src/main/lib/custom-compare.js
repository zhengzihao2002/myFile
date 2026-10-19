"use strict";

// "Custom" compare mode, shared by Folder Compare and Sync: the user ticks
// which facts must match (Settings › What counts as identical).

const DEFAULT_CUSTOM = { size: true, modified: true, created: false, exifDates: true, gps: true, otherMeta: false, contents: false };
const META_KINDS = ["exifDates", "gps", "otherMeta"];
const META_LABELS = { exifDates: "photo/video dates", gps: "GPS", otherMeta: "other metadata" };
const META_BATCH = 25;

const IGNORED_TAG = /^(System:|ExifTool:|SourceFile$|File:(FileName|Directory|FileSize|FileModifyDate|FileAccessDate|FileInodeChangeDate|FileCreateDate|FilePermissions)$)/;
const DATE_TAG = /^(DateTimeOriginal|DateTimeDigitized|CreateDate|ModifyDate|DateTime|SubSecTime\w*|OffsetTime\w*|MediaCreateDate|MediaModifyDate|TrackCreateDate|TrackModifyDate|CreationDate|DateCreated|TimeCreated|DateTimeCreated|MetadataDate)$/;

const tagText = (v) => (typeof v === "string" ? v : JSON.stringify(v));

function resolveCustom(settings, override) {
  return { ...DEFAULT_CUSTOM, ...(settings && settings.customCompare), ...override };
}

/** The metadata groups to read for these choices; none when every byte is compared (that covers them). */
function metaWanted(custom) {
  return custom.contents ? [] : META_KINDS.filter((k) => custom[k]);
}

/** Splits one file's ExifTool output into { exifDates, gps, otherMeta } maps of tag -> text. */
function metaGroups(row) {
  const out = { exifDates: new Map(), gps: new Map(), otherMeta: new Map() };
  for (const [key, value] of Object.entries(row || {})) {
    if (IGNORED_TAG.test(key) || /^(File|Composite):/.test(key)) continue;
    const name = key.replace(/^[^:]+:/, "");
    const kind = /^GPS:/.test(key) || /^GPS/.test(name) ? "gps" : DATE_TAG.test(name) ? "exifDates" : "otherMeta";
    out[kind].set(key, tagText(value));
  }
  return out;
}

/** Which of the wanted metadata groups differ between two files, with the tags that differ. */
function metaDifferences(ra, rb, want) {
  const ga = metaGroups(ra);
  const gb = metaGroups(rb);
  const groups = [];
  const tags = [];
  for (const kind of want) {
    const keys = new Set([...ga[kind].keys(), ...gb[kind].keys()]);
    let differs = false;
    for (const k of keys) {
      const x = ga[kind].has(k) ? ga[kind].get(k) : null;
      const y = gb[kind].has(k) ? gb[kind].get(k) : null;
      if (x === y) continue;
      differs = true;
      tags.push({ tag: k, a: x && x.length > 160 ? `${x.slice(0, 160)}…` : x, b: y && y.length > 160 ? `${y.slice(0, 160)}…` : y });
    }
    if (differs) groups.push(kind);
  }
  return { groups, tags };
}

/** One line such as "GPS differ: GPSLatitude, GPSLongitude +1 more". */
function metaNote(diff) {
  const names = diff.groups.map((k) => META_LABELS[k]).join(" and ");
  const tags = diff.tags.slice(0, 3).map((t) => t.tag.replace(/^[^:]+:/, "")).join(", ");
  return `${names} differ: ${tags}${diff.tags.length > 3 ? ` +${diff.tags.length - 3} more` : ""}`;
}

/**
 * Reads the wanted metadata of each [pathA, pathB] pair from the file headers
 * (ExifTool, 25 files per run) and returns one metaDifferences result per pair.
 * Files ExifTool can't read count as having no metadata.
 */
async function compareMeta(et, pairs, want, { signal, onProgress } = {}) {
  const results = [];
  for (let i = 0; i < pairs.length; i += META_BATCH) {
    const batch = pairs.slice(i, i + META_BATCH);
    const read = async (side) => {
      try {
        const rows = await et.readJson(batch.map((p) => p[side]), ["-G1", "-a", "-s"], { signal });
        return new Map(rows.map((r) => [String(r.SourceFile).normalize("NFC"), r]));
      } catch (err) {
        if (err.code === "CANCELLED") throw err;
        return new Map();
      }
    };
    const [mapA, mapB] = await Promise.all([read(0), read(1)]);
    for (const [a, b] of batch) results.push(metaDifferences(mapA.get(a.normalize("NFC")), mapB.get(b.normalize("NFC")), want));
    if (onProgress) onProgress(results.length, batch[batch.length - 1][0]);
  }
  return results;
}

module.exports = { DEFAULT_CUSTOM, resolveCustom, metaWanted, metaNote, compareMeta };

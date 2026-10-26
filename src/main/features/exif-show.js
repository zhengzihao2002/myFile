"use strict";

// EXIF › Show: everything about one photo or video, plus a preview.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { UserError, errText, extOf } = require("../lib/util");
const { mediaKind, BROWSER_IMAGE, BROWSER_VIDEO, mimeOf, isQuickTime } = require("../lib/media");
const { bestDate, momentText } = require("../lib/dates");
const tz = require("../lib/tz");

// QuickTime stores these as one exact moment (UTC) and no zone; ExifTool only shows them in this Mac's zone.
const ABSOLUTE_TAGS = new Set(["QuickTime:CreateDate", "TrackCreateDate", "MediaCreateDate"]);

const IS_MAC = process.platform === "darwin";

const GROUP_LABELS = {
  System: "File system",
  File: "File",
  IFD0: "EXIF · Main image",
  ExifIFD: "EXIF · Capture",
  IFD1: "EXIF · Thumbnail",
  GPS: "GPS",
  InteropIFD: "EXIF · Interoperability",
  Composite: "Calculated by ExifTool",
  QuickTime: "QuickTime",
  Keys: "QuickTime · Apple keys",
  UserData: "QuickTime · User data",
  ItemList: "QuickTime · Item list",
  ExifTool: "ExifTool",
  JFIF: "JFIF",
  ICC_Profile: "Color profile",
  "ICC-header": "Color profile",
  MPF0: "Multi-picture",
  Photoshop: "Photoshop",
  IPTC: "IPTC",
  Apple: "Apple maker notes",
};

// Groups shown first, in this order; everything else follows alphabetically.
const GROUP_ORDER = ["System", "File", "IFD0", "ExifIFD", "GPS", "QuickTime", "Keys", "UserData", "ItemList", "Composite"];

function humanizeTag(tag) {
  return tag
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/^GPS /, "GPS ");
}

function groupLabel(group) {
  if (GROUP_LABELS[group]) return GROUP_LABELS[group];
  if (/^XMP-/.test(group)) return `XMP · ${group.slice(4)}`;
  if (/^Track\d+$/.test(group)) return `QuickTime · ${group.replace("Track", "Track ")}`;
  if (/^ICC/.test(group)) return "Color profile";
  return group;
}

function pick(raw, ...tags) {
  for (const tag of tags) {
    for (const [key, value] of Object.entries(raw)) {
      const name = key.slice(key.lastIndexOf(":") + 1);
      if (name === tag && value !== "" && value !== undefined) return value;
    }
  }
  return null;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return null;
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

function takenInfo(taken, movie) {
  const m = taken.moment;
  const exact = movie && ABSOLUTE_TAGS.has(taken.tag) && Number.isFinite(m.ms);
  if (exact) return { text: tz.instantToWall(m.ms, { offsetMin: 0 }), ms: m.ms, source: taken.source, offset: null, utc: true };
  return { text: momentText(m), ms: m.ms, source: taken.source, offset: m.offset };
}

async function inspect(ctx, { path: file }) {
  let st;
  try {
    st = await fs.promises.stat(file);
  } catch (err) {
    throw new UserError(`Can't open ${path.basename(file)}: ${errText(err)}`);
  }
  if (st.isDirectory()) throw new UserError("That's a folder. Drop a photo or video file here.");

  const [raw = {}] = await ctx.et.readJson([file], ["-G1", "-a", "-s"]);
  const [num = {}] = await ctx.et.readJson([file], [
    "-n", "-s",
    "-Composite:GPSLatitude", "-Composite:GPSLongitude", "-Composite:GPSAltitude",
    "-ImageWidth", "-ImageHeight", "-Duration", "-Rotation", "-Orientation",
  ]);
  delete raw.SourceFile;

  // Group every tag for the "All metadata" list.
  const groups = new Map();
  for (const [key, value] of Object.entries(raw)) {
    const colon = key.lastIndexOf(":");
    const group = colon > 0 ? key.slice(0, colon) : "Other";
    const tag = key.slice(colon + 1);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ tag, label: humanizeTag(tag), value: typeof value === "object" ? JSON.stringify(value) : String(value) });
  }
  const groupList = [...groups.entries()]
    .sort(([a], [b]) => {
      const ia = GROUP_ORDER.indexOf(a);
      const ib = GROUP_ORDER.indexOf(b);
      if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      return a.localeCompare(b);
    })
    .map(([group, tags]) => ({ group, label: groupLabel(group), tags }));

  const kind = mediaKind(file) || "other";
  const movie = kind === "video" || isQuickTime(file);
  const taken = bestDate(raw, { movie });

  const lat = Number(num.GPSLatitude);
  const lon = Number(num.GPSLongitude);
  const gps = Number.isFinite(lat) && Number.isFinite(lon) && num.GPSLatitude !== undefined
    ? { lat, lon, alt: Number.isFinite(Number(num.GPSAltitude)) ? Number(num.GPSAltitude) : null, text: pick(raw, "GPSPosition", "GPSCoordinates") }
    : null;

  const width = Number(num.ImageWidth) || null;
  const height = Number(num.ImageHeight) || null;
  const make = pick(raw, "Make");
  const model = pick(raw, "Model");
  const camera = [make, model && make && String(model).startsWith(String(make)) ? String(model).slice(String(make).length).trim() : model]
    .filter(Boolean)
    .join(" ");

  const summary = {
    camera: camera || null,
    lens: pick(raw, "LensModel", "LensID", "Lens"),
    exposure: pick(raw, "ExposureTime"),
    aperture: pick(raw, "FNumber", "Aperture"),
    iso: pick(raw, "ISO"),
    focalLength: pick(raw, "FocalLengthIn35mmFormat", "FocalLength"),
    flash: pick(raw, "Flash"),
    dimensions: width && height ? `${width} × ${height}` : pick(raw, "ImageSize"),
    megapixels: width && height ? Math.round((width * height) / 100000) / 10 : null,
    duration: formatDuration(Number(num.Duration)),
    codec: pick(raw, "CompressorName", "CompressorID", "VideoCodec"),
    frameRate: pick(raw, "VideoFrameRate"),
    software: pick(raw, "Software", "CreatorTool"),
    fileType: pick(raw, "FileType"),
    mime: pick(raw, "MIMEType") || mimeOf(file),
    orientation: pick(raw, "Orientation"),
  };

  const preview = previewFor(ctx, file);

  return {
    path: file,
    name: path.basename(file),
    folder: path.dirname(file),
    size: st.size,
    kind,
    times: { createdMs: st.birthtimeMs, modifiedMs: st.mtimeMs, accessedMs: st.atimeMs },
    taken: taken ? takenInfo(taken, movie) : null,
    gps,
    summary,
    groups: groupList,
    tagCount: Object.keys(raw).length,
    preview,
  };
}

/** How to show a file in the window: { type: "image"|"video"|"pending"|"none", url? }. "pending" means ask exif.preview. */
function previewFor(ctx, file) {
  const kind = mediaKind(file) || "other";
  const ext = extOf(file);
  if (kind === "image" && BROWSER_IMAGE.has(ext)) return { type: "image", url: ctx.fileUrl(file) };
  if (kind === "video" && BROWSER_VIDEO.has(ext)) return { type: "video", url: ctx.fileUrl(file) };
  if (kind === "image" || kind === "video") return { type: "pending" };
  return { type: "none" };
}

function cacheName(file, st, suffix) {
  const hash = crypto.createHash("sha1").update(`${file}|${st.size}|${st.mtimeMs}`).digest("hex").slice(0, 20);
  return `${hash}${suffix}`;
}

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60000, maxBuffer: 256 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

// Embedded JPEG previews that RAW and HEIC files usually carry.
async function extractEmbedded(ctx, file, dest) {
  for (const tag of ["PreviewImage", "JpgFromRaw", "OtherImage", "ThumbnailImage"]) {
    try {
      const buf = await run(ctx.runtime.perl, [ctx.runtime.exiftool, "-b", `-${tag}`, file], { encoding: "buffer" });
      if (buf && buf.length > 1000) {
        await fs.promises.writeFile(dest, buf);
        return true;
      }
    } catch {
      // try the next one
    }
  }
  return false;
}

/** A JPEG version of a HEIC, RAW, TIFF or similar photo, cached in the data folder. Null if none can be made. */
async function convertedImage(ctx, file) {
  const st = await fs.promises.stat(file);
  await fs.promises.mkdir(ctx.runtime.previewDir, { recursive: true });
  const dest = path.join(ctx.runtime.previewDir, cacheName(file, st, ".jpg"));
  if (fs.existsSync(dest)) return { file: dest, embedded: false };
  if (IS_MAC) {
    try {
      await run("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "85", "-Z", "2400", file, "--out", dest]);
      if (fs.existsSync(dest)) return { file: dest, embedded: false };
    } catch {
      // fall through to the embedded preview
    }
  }
  if (await extractEmbedded(ctx, file, dest)) return { file: dest, embedded: true };
  return null;
}

/** Makes a browser-viewable preview for HEIC, RAW, TIFF and similar files. */
async function preview(ctx, { path: file }) {
  const kind = mediaKind(file);
  if (kind === "image") {
    const img = await convertedImage(ctx, file);
    if (img) return { type: "image", url: ctx.fileUrl(img.file), converted: true, embedded: img.embedded };
    return { type: "none", note: "No preview is available for this file type." };
  }

  if (kind === "video") return poster(ctx, { path: file });
  return { type: "none" };
}

/** A still frame for videos the built-in player can't decode. */
async function poster(ctx, { path: file }) {
  const st = await fs.promises.stat(file);
  const dest = path.join(ctx.runtime.previewDir, cacheName(file, st, ".png"));
  if (fs.existsSync(dest)) return { type: "poster", url: ctx.fileUrl(dest) };
  if (IS_MAC) {
    const outDir = path.join(ctx.runtime.previewDir, `ql-${Date.now()}`);
    await fs.promises.mkdir(outDir, { recursive: true });
    try {
      await run("/usr/bin/qlmanage", ["-t", "-s", "1600", "-o", outDir, file]);
      const made = (await fs.promises.readdir(outDir)).find((n) => n.endsWith(".png"));
      if (made) {
        await fs.promises.rename(path.join(outDir, made), dest);
        return { type: "poster", url: ctx.fileUrl(dest) };
      }
    } catch {
      // no thumbnail
    } finally {
      fs.promises.rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return { type: "none", note: "This video can't be played here. Open it in QuickTime Player instead." };
}

const PICTURE_MAX_BYTES = 80 * 1024 * 1024;

/**
 * The picture of a photo as base64 JPEG/PNG/... bytes the window can decode,
 * for comparing what two photos look like. Null for videos and unknown types.
 */
async function pictureData(ctx, { path: file }) {
  if (mediaKind(file) !== "image") return null;
  const ext = path.extname(file).slice(1).toLowerCase();
  let src = file;
  if (!BROWSER_IMAGE.has(ext) || ext === "svg") {
    const img = await convertedImage(ctx, file);
    if (!img) return null;
    src = img.file;
  }
  const st = await fs.promises.stat(src);
  if (st.size > PICTURE_MAX_BYTES) return null;
  return { base64: (await fs.promises.readFile(src)).toString("base64") };
}

module.exports = { inspect, preview, poster, pictureData, previewFor, humanizeTag };

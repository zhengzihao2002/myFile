"use strict";

// EXIF-style dates: "YYYY:MM:DD HH:MM:SS", optionally with a fraction and a
// zone ("Z" or "+08:00"). An unzoned wall clock has no known instant.

const { splitKey } = require("./exiftool");

const DATE_RE = /^(\d{4})[:\-/](\d{2})[:\-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})?/i;

function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

function parseExifDate(value) {
  if (value === null || value === undefined) return null;
  const m = DATE_RE.exec(String(value).trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s = "00", frac = "", zone] = m;
  if (Number(y) < 1800 || Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  let offsetMin = null;
  if (zone) {
    if (zone.toUpperCase() === "Z") offsetMin = 0;
    else {
      const z = zone.replace(":", "");
      const sign = z[0] === "-" ? -1 : 1;
      offsetMin = sign * (Number(z.slice(1, 3)) * 60 + Number(z.slice(3, 5)));
    }
  }
  return {
    y: Number(y),
    mo: Number(mo),
    d: Number(d),
    h: Number(h),
    mi: Number(mi),
    s: Number(s),
    frac,
    offsetMin,
  };
}

function fracMs(frac) {
  if (!frac) return 0;
  return Number(`0.${frac}`) * 1000;
}

/** Epoch milliseconds for a parsed date; null when its zone is unknown. */
function toMs(p, extraFrac) {
  const frac = fracMs(p.frac || extraFrac || "");
  if (p.offsetMin === null) {
    return null;
  }
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - p.offsetMin * 60000 + frac;
}

function offsetString(min) {
  const sign = min < 0 ? "-" : "+";
  const abs = Math.abs(min);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function parseOffset(text) {
  if (!text) return null;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(String(text).trim());
  if (!m) return String(text).trim().toUpperCase() === "Z" ? 0 : null;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** "YYYY:MM:DD HH:MM:SS" for a parsed date's wall-clock fields. */
function wallClock(p) {
  return `${p.y}:${pad(p.mo)}:${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
}

/** Wall-clock text of an instant as seen at a given offset (minutes) or local time. */
function msToWallClock(ms, offsetMin = 0) {
  const whole = Math.floor(ms / 1000) * 1000;
  if (offsetMin === null) throw new Error("Choose an explicit time zone before converting this date.");
  const d = new Date(whole + offsetMin * 60000);
  return `${d.getUTCFullYear()}:${pad(d.getUTCMonth() + 1)}:${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * A "moment": one point in time with the pieces EXIF stores separately.
 *   wall   "2021:07:04 15:30:45"  (local wall-clock time where it was taken)
 *   subsec "123" or ""
 *   offset "-07:00" or ""          (empty when the source didn't say)
 *   ms     epoch milliseconds
 */
function makeMoment(dateText, subsec, offsetText) {
  const p = parseExifDate(dateText);
  if (!p) return null;
  let offsetMin = p.offsetMin;
  if (offsetMin === null && offsetText) offsetMin = parseOffset(offsetText);
  const frac = p.frac || (subsec !== undefined && subsec !== null ? String(subsec).trim() : "");
  const parsed = { ...p, offsetMin, frac: /^\d+$/.test(frac) ? frac : "" };
  return {
    wall: wallClock(p),
    subsec: parsed.frac,
    offset: offsetMin === null ? "" : offsetString(offsetMin),
    ms: toMs(parsed),
  };
}

/** Display text: "2021:07:04 15:30:45.123 -07:00". */
function momentText(m) {
  if (!m) return "";
  return `${m.wall}${m.subsec ? `.${m.subsec}` : ""}${m.offset ? ` ${m.offset}` : ""}`;
}

/** Full date with its stored zone, as QuickTime/Keys tags want it. */
function momentWithZone(m) {
  if (!m.offset) throw new Error("This date has no stored time zone. Choose its time zone before converting it to a video timestamp.");
  const offset = m.offset;
  return `${m.wall}${m.subsec ? `.${m.subsec}` : ""}${offset}`;
}

function isValidDateValue(v) {
  if (v === null || v === undefined) return false;
  const s = String(v);
  return !/^0000/.test(s) && parseExifDate(s) !== null;
}

/**
 * Picks the date a photo or video was taken from a "-G0:1" ExifTool snapshot.
 * Returns { moment, source } or null.
 */
function bestDate(tags, { movie = false } = {}) {
  const byName = {};
  for (const [key, value] of Object.entries(tags || {})) {
    const { group1, tag } = splitKey(key);
    if (!byName[`${group1}:${tag}`]) byName[`${group1}:${tag}`] = value;
    if (!byName[tag]) byName[tag] = value;
  }
  const get = (k) => byName[k];
  const anyOffset = get("ExifIFD:OffsetTimeOriginal") || get("ExifIFD:OffsetTimeDigitized") || get("IFD0:OffsetTime") || get("ExifIFD:OffsetTime");

  const exifSources = [
    ["ExifIFD:DateTimeOriginal", "ExifIFD:SubSecTimeOriginal", "ExifIFD:OffsetTimeOriginal", "Date Taken (DateTimeOriginal)"],
    ["ExifIFD:CreateDate", "ExifIFD:SubSecTimeDigitized", "ExifIFD:OffsetTimeDigitized", "Digitized (CreateDate)"],
    ["IFD0:ModifyDate", "ExifIFD:SubSecTime", "ExifIFD:OffsetTime", "EXIF ModifyDate"],
    ["XMP-exif:DateTimeOriginal", null, null, "XMP DateTimeOriginal"],
    ["XMP-photoshop:DateCreated", null, null, "XMP DateCreated"],
    ["XMP-xmp:CreateDate", null, null, "XMP CreateDate"],
  ];
  const movieSources = [
    ["Keys:CreationDate", null, null, "Apple CreationDate (Keys)"],
    ["UserData:DateTimeOriginal", null, null, "QuickTime DateTimeOriginal"],
    ["QuickTime:CreateDate", null, null, "QuickTime CreateDate"],
    ["TrackCreateDate", null, null, "Track CreateDate"],
    ["MediaCreateDate", null, null, "Media CreateDate"],
  ];
  const order = movie ? movieSources.concat(exifSources) : exifSources.concat(movieSources);
  for (const [dateKey, subKey, offKey, label] of order) {
    const value = get(dateKey);
    if (!isValidDateValue(value)) continue;
    const isExif = dateKey.startsWith("ExifIFD") || dateKey.startsWith("IFD0");
    const offset = offKey ? get(offKey) || (isExif ? anyOffset : null) : null;
    const moment = makeMoment(value, subKey ? get(subKey) : null, offset);
    if (moment) return { moment, source: label, tag: dateKey };
  }
  return null;
}

module.exports = {
  parseExifDate,
  parseOffset,
  offsetString,
  toMs,
  wallClock,
  msToWallClock,
  makeMoment,
  momentText,
  momentWithZone,
  bestDate,
  isValidDateValue,
};

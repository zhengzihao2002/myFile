"use strict";

// Time zones for Batch Modify.
//
// A photo's EXIF date is a wall-clock time ("2023:05:01 12:00:00") that only
// means something together with a time zone, while a file's created and
// modified dates are exact instants. These helpers convert between the two:
//   zone spec  { zone: "Asia/Shanghai" }   follows daylight saving
//              { offsetMin: 480 }          a fixed UTC offset ("+08:00")

const tzLookup = require("../vendor/tz-lookup");
const { parseExifDate, offsetString } = require("./dates");

const pad = (n, w = 2) => String(n).padStart(w, "0");

// Zones offered as one-click choices (the first two are what most people here need).
const QUICK_ZONES = [
  { id: "Asia/Shanghai", label: "Beijing (China)" },
  { id: "America/New_York", label: "Eastern (New York)" },
  { id: "America/Chicago", label: "Central (Chicago)" },
  { id: "America/Denver", label: "Mountain (Denver)" },
  { id: "America/Los_Angeles", label: "Pacific (Los Angeles)" },
  { id: "UTC", label: "UTC" },
  { id: "Europe/London", label: "London" },
  { id: "Europe/Paris", label: "Paris / Berlin / Rome" },
  { id: "Asia/Dubai", label: "Dubai" },
  { id: "Asia/Kolkata", label: "India" },
  { id: "Asia/Bangkok", label: "Bangkok" },
  { id: "Asia/Singapore", label: "Singapore" },
  { id: "Asia/Hong_Kong", label: "Hong Kong" },
  { id: "Asia/Taipei", label: "Taipei" },
  { id: "Asia/Tokyo", label: "Tokyo" },
  { id: "Asia/Seoul", label: "Seoul" },
  { id: "Australia/Sydney", label: "Sydney" },
  { id: "Pacific/Auckland", label: "Auckland" },
];

const formatters = new Map();
function formatterFor(zone) {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(zone, f);
  }
  return f;
}

function isValidZone(zone) {
  try {
    formatterFor(zone);
    return true;
  } catch {
    return false;
  }
}

function systemZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** UTC offset in minutes of a named zone at an instant (daylight saving included). */
function zoneOffsetAt(zone, ms) {
  const whole = Math.floor(ms / 1000) * 1000;
  const parts = {};
  for (const p of formatterFor(zone).formatToParts(new Date(whole))) parts[p.type] = p.value;
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - whole) / 60000);
}

/** UTC offset (minutes) a zone spec has at an instant. */
function offsetAt(spec, ms) {
  if (spec.offsetMin !== undefined && spec.offsetMin !== null) return spec.offsetMin;
  return zoneOffsetAt(spec.zone, ms);
}

/** The instant at which a wall-clock time shows on the clocks of a zone. */
function wallToInstant(p, spec, fracMs = 0) {
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  if (spec.offsetMin !== undefined && spec.offsetMin !== null) return asUtc - spec.offsetMin * 60000 + fracMs;
  const first = asUtc - zoneOffsetAt(spec.zone, asUtc) * 60000;
  const second = asUtc - zoneOffsetAt(spec.zone, first) * 60000; // across a daylight-saving change
  return second + fracMs;
}

/** "YYYY:MM:DD HH:MM:SS" for an instant on a zone's clocks. */
function instantToWall(ms, spec) {
  const whole = Math.floor(ms / 1000) * 1000;
  const d = new Date(whole + offsetAt(spec, whole) * 60000);
  return `${d.getUTCFullYear()}:${pad(d.getUTCMonth() + 1)}:${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** "+08:00" for a zone spec at an instant. */
function offsetTextAt(spec, ms) {
  return offsetString(offsetAt(spec, ms));
}

/** "UTC+08:00" / "UTC-04:00" for display. */
function utcLabel(min) {
  return `UTC${offsetString(min)}`;
}

/** A readable name for a zone spec at an instant, e.g. "Beijing (UTC+08:00)". */
function describeSpec(spec, ms) {
  const min = offsetAt(spec, ms);
  if (spec.zone) {
    const quick = QUICK_ZONES.find((q) => q.id === spec.zone);
    const name = quick ? quick.label : spec.zone.replace(/_/g, " ");
    return `${name} (${utcLabel(min)})`;
  }
  return utcLabel(min);
}

/** "2023-05-01 12:00:00" for an instant as seen on a zone's clocks. */
function formatInstant(ms, spec) {
  return instantToWall(ms, spec).replace(/:/, "-").replace(/:/, "-");
}

/** The IANA zone a GPS position is in, or null. Close to borders it can be wrong. */
function zoneFromGps(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  try {
    const zone = tzLookup(lat, lon);
    return zone && isValidZone(zone) ? zone : null;
  } catch {
    return null;
  }
}

/** Turns the UI's choice ("Asia/Shanghai" or "+08:00") into a zone spec, or null. */
function parseSpec(value) {
  if (!value) return null;
  if (typeof value === "object") {
    if (value.zone && isValidZone(value.zone)) return { zone: value.zone };
    if (Number.isFinite(value.offsetMin)) return { offsetMin: Math.round(value.offsetMin) };
    return null;
  }
  const text = String(value).trim();
  const m = /^(?:UTC)?([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(text);
  if (m) return { offsetMin: (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) };
  return isValidZone(text) ? { zone: text } : null;
}

module.exports = {
  QUICK_ZONES,
  isValidZone,
  systemZone,
  zoneOffsetAt,
  offsetAt,
  wallToInstant,
  instantToWall,
  offsetTextAt,
  utcLabel,
  describeSpec,
  formatInstant,
  zoneFromGps,
  parseSpec,
  parseExifDate,
};

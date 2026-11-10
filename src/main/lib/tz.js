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
const { UserError } = require("./util");

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
  if (typeof zone !== "string" || !zone.trim()) return false;
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

// EXIF offsets describe whole minutes, with the civil-time range UTC−14 to UTC+14.
const validOffset = (min) => Number.isInteger(min) && Math.abs(min) <= 14 * 60;

/** The instant at which a wall-clock time shows on the clocks of a zone. */
function wallToInstant(p, spec, fracMs = 0) {
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  if (spec.offsetMin !== undefined && spec.offsetMin !== null) {
    if (!validOffset(spec.offsetMin)) throw new UserError("Choose a valid UTC offset between −14:00 and +14:00, with minutes from 00 to 59.");
    return asUtc - spec.offsetMin * 60000 + fracMs;
  }
  if (!isValidZone(spec.zone)) throw new UserError("Choose a valid time zone or fixed UTC offset.");
  // A local wall clock can identify zero instants (spring gap), one instant,
  // or two instants (fall overlap). Find and round-trip candidates instead of
  // silently normalizing a missing hour or choosing one occurrence of two.
  // Sampling both sides also covers half-hour changes and date-line skips.
  const offsets = new Set();
  for (let hours = -48; hours <= 48; hours += 6) offsets.add(zoneOffsetAt(spec.zone, asUtc + hours * 3600000));
  const candidates = [];
  for (const offset of offsets) {
    const instant = asUtc - offset * 60000;
    if (instant + zoneOffsetAt(spec.zone, instant) * 60000 === asUtc) candidates.push(instant);
  }
  if (candidates.length === 0) throw new UserError(`This local time does not exist in ${spec.zone} because the clock moved forward. Choose the correct fixed UTC offset (for example −05:00) instead of a city time zone.`);
  if (candidates.length > 1) throw new UserError(`This local time occurs twice in ${spec.zone} because the clock moved back. Choose the intended fixed UTC offset (for example −04:00 or −05:00) instead of a city time zone.`);
  return candidates[0] + fracMs;
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
    if (value.offsetMin !== undefined && value.offsetMin !== null && !validOffset(value.offsetMin)) return null;
    if (value.zone && isValidZone(value.zone)) return { zone: value.zone };
    if (value.zone) return null;
    if (validOffset(value.offsetMin)) return { offsetMin: value.offsetMin };
    return null;
  }
  const text = String(value).trim();
  const m = /^(?:UTC)?([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(text);
  if (m) {
    const minutes = Number(m[3] || 0);
    const offsetMin = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + minutes);
    return minutes < 60 && validOffset(offsetMin) ? { offsetMin } : null;
  }
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

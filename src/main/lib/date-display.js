"use strict";

// Shared display rules for Show and Modify. An offset printed by ExifTool
// for an integer QuickTime timestamp is a conversion, not a stored offset.
const tz = require("./tz");
const { parseOffset } = require("./dates");
const ABSOLUTE_TAGS = new Set(["QuickTime:CreateDate", "TrackCreateDate", "MediaCreateDate"]);

function fileZone(taken, movie) {
  if (!taken) return null;
  if (movie && ABSOLUTE_TAGS.has(taken.tag)) return { offsetMin: 0 };
  const offsetMin = parseOffset(taken.moment.offset);
  return offsetMin === null ? null : { offsetMin };
}

function fraction(ms) {
  return Number.isFinite(ms) ? ((ms - Math.floor(ms / 1000) * 1000) / 1000).toFixed(6).slice(2).replace(/0+$/, "") : "";
}

function stamp(ms, spec) {
  if (!Number.isFinite(ms) || !spec) return null;
  const subsec = fraction(ms);
  return `${tz.formatInstant(ms, spec)}${subsec ? `.${subsec}` : ""} ${tz.utcLabel(tz.offsetAt(spec, ms))}`;
}

function zoneLabel(spec, ms) {
  return tz.utcLabel(tz.offsetAt(spec, ms));
}

module.exports = { ABSOLUTE_TAGS, fileZone, fraction, stamp, zoneLabel };

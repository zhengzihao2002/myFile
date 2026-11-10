"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const tz = require("../src/main/lib/tz");
const batch = require("../src/main/features/exif-batch");

const opts = { birthSupported: true, tolMs: 1000, useGps: false };
const photo = (wall, over = {}) => ({ movie: false, has: true, wall, fracMs: 123.456, subsec: "123456", absolute: false, absMs: null, storedOffsetMin: null, gps: null, createdMs: Date.parse("2024-01-01T00:00:00Z"), modifiedMs: Date.parse("2024-01-01T00:00:00Z"), ...over });
const wall = (text) => tz.parseExifDate(text);

test("UTC offsets reject invalid minutes, range and non-integer object offsets", () => {
  for (const value of ["+08:99", "-01:60", "+15:00", "+14:01", "-14:01", "+99:00", { offsetMin: 841 }, { offsetMin: -841 }, { offsetMin: 1.5 }, { offsetMin: Infinity }, { offsetMin: NaN }, { zone: "UTC", offsetMin: 9999 }, { zone: "Not/AZone", offsetMin: 480 }, {}, []]) assert.equal(tz.parseSpec(value), null, JSON.stringify(value));
  for (const [value, offsetMin] of [["+14:00", 840], ["-14:00", -840], ["+05:45", 345], ["-3", -180], ["UTC+08:00", 480], [{ offsetMin: 0 }, 0]]) assert.deepEqual(tz.parseSpec(value), { offsetMin });
  assert.equal(tz.isValidZone(undefined), false, "missing zone must never imply the host's time zone");
  assert.throws(() => tz.wallToInstant(wall("2023:05:01 12:00:00"), { offsetMin: 9999 }), /valid UTC offset/);
});

test("city-zone conversion rejects spring gaps and fall overlaps instead of guessing an instant", () => {
  for (const [text, zone, message] of [
    ["2023:03:12 02:30:00", "America/New_York", /does not exist/],
    ["2023:11:05 01:30:00", "America/New_York", /occurs twice/],
    ["2023:10:01 02:15:00", "Australia/Lord_Howe", /does not exist/],
    ["2023:04:02 01:45:00", "Australia/Lord_Howe", /occurs twice/],
    ["2011:12:30 12:00:00", "Pacific/Apia", /does not exist/],
  ]) {
    assert.throws(() => tz.wallToInstant(wall(text), { zone }), (err) => err.code === "USER" && message.test(err.message) && /fixed UTC offset/.test(err.message), `${text} in ${zone}`);
    assert.throws(() => batch.computeOutcome(photo(text), { tz: zone, set: { modified: "exif" } }, opts), message);
  }
});

test("fixed offsets explicitly choose either repeated-hour instant and retain fractional seconds", () => {
  const p = wall("2023:11:05 01:30:00");
  const first = tz.wallToInstant(p, { offsetMin: -240 }, 123.456);
  const second = tz.wallToInstant(p, { offsetMin: -300 }, 123.456);
  assert.equal(second - first, 3600000);
  assert.ok(Math.abs(first - (Date.parse("2023-11-05T05:30:00Z") + 123.456)) < 0.001);
  for (const [offset, expected] of [["-04:00", first], ["-05:00", second]]) {
    const out = batch.computeOutcome(photo("2023:11:05 01:30:00"), { tz: offset, set: { modified: "exif" } }, opts);
    assert.equal(out.after.modified, expected);
    assert.equal(out.needsZone, false);
  }
  assert.equal(tz.instantToWall(tz.wallToInstant(wall("2023:03:12 03:30:00"), { zone: "America/New_York" }), { zone: "America/New_York" }), "2023:03:12 03:30:00");
});

test("invalid requested zones fail instead of falling back to the stored photo offset", () => {
  const file = photo("2023:05:01 12:00:00", { storedOffsetMin: 480 });
  for (const value of ["+08:99", "Not/AZone", { offsetMin: 0.5 }]) assert.throws(() => batch.computeOutcome(file, { tz: value, set: { modified: "exif" } }, opts), /valid city time zone or UTC offset/);
  const malformed = batch.computeOutcome({ ...file, storedOffsetMin: 9999 }, {}, opts);
  assert.equal(malformed.needsZone, true, "bad stored offsets require a choice instead of invalidating the entire scan");
});

test("absolute video timestamps stay exact through a city-zone daylight-saving transition", () => {
  const absolute = Date.parse("2023-11-05T05:30:00Z") + 123;
  const video = photo("2023:11:05 05:30:00", { movie: true, absolute: true, absMs: absolute, storedOffsetMin: null });
  const out = batch.computeOutcome(video, { tz: "America/New_York", set: { modified: "exif" } }, opts);
  assert.equal(out.after.modified, absolute);
  assert.equal(out.needsZone, false);
  const utc = batch.computeOutcome(video, { set: { modified: "exif" } }, opts);
  assert.equal(utc.after.modified, absolute);
});

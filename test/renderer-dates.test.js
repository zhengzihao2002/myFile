"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
function renderer() {
  const context = vm.createContext({ window: {}, document: { addEventListener() {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/renderer/js/core.js"), "utf8"), context);
  const mf = context.window.MF;
  // Only the element factory is replaced; formatting and Change/DateChange are real.
  mf.h = (tag, ...children) => ({ tag, children });
  mf.icon = () => ({ tag: "svg" });
  context.MF = mf;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/renderer/js/components.js"), "utf8"), context);
  return mf;
}
test("date previews show both values for seconds and milliseconds, and no change for equal dates", () => {
  const mf = renderer();
  const start = Date.parse("2023-05-01T16:00:00Z");
  for (const delta of [1000, 123]) {
    const el = mf.DateChange(start, start + delta);
    assert.equal(el.tag, "span.arrow-change");
    assert.equal(el.children[0].tag, "span.old");
    assert.equal(el.children[2].tag, "span.new");
    assert.notEqual(el.children[0].children[0], el.children[2].children[0]);
    assert.match(el.title, /UTC[+-]\d{2}:\d{2}/);
  }
  assert.equal(mf.DateChange(start, start).tag, "span");
});
test("epoch and pre-1970 file dates are displayed instead of a missing-date dash", () => {
  const { fmt } = renderer();
  for (const ms of [0, -1000]) {
    assert.notEqual(fmt.date(ms), "—");
    assert.notEqual(fmt.nice(ms), "—");
  }
  for (const ms of [null, undefined, NaN, Infinity, 1e20]) assert.equal(fmt.date(ms), "—");
});

test("file-system-only comparisons use UTC even on a Mac in a DST zone", () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    const mf = renderer();
    const el = mf.DateChange(Date.parse("2023-11-05T05:30:00Z"), Date.parse("2023-11-05T06:30:00Z"));
    assert.equal(el.tag, "span.arrow-change");
    assert.match(el.children[0].children[0], /05:30:00.000 UTC\+00:00/);
    assert.match(el.children[2].children[0], /06:30:00.000 UTC\+00:00/);
    assert.equal(mf.fmt.date(Date.parse("2023-05-01T04:00:00Z"), { zone: true, offsetMin: 480 }), "2023-05-01 12:00:00 UTC+08:00");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("app-wide date and history formatting stays identical when the host time zone changes", () => {
  const previous = process.env.TZ;
  const values = [];
  try {
    for (const zone of ["UTC", "America/New_York", "Asia/Shanghai"]) {
      process.env.TZ = zone;
      const {fmt}=renderer();
      const ms=Date.parse("2015-12-29T19:28:42Z");
      values.push([fmt.date(ms),fmt.nice(ms),fmt.ago(ms)]);
    }
    assert.deepEqual(values[1],values[0]);
    assert.deepEqual(values[2],values[0]);
    assert.equal(values[0][0],"2015-12-29 19:28:42 UTC+00:00");
  } finally {
    if (previous===undefined) delete process.env.TZ;
    else process.env.TZ=previous;
  }
});

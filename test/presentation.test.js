"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const P = require("../src/shared/presentation");
const { Settings } = require("../src/main/lib/store");
const { tmpDir } = require("./helpers");
test("presentation preferences default, persist and validate independently", () => {
  const dir = tmpDir("preferences");
  const settings = new Settings(dir);
  assert.equal(settings.get().language, "en");
  assert.equal(settings.get().timeFormat, "24");
  settings.set({ language: "zh-CN", timeFormat: "12" });
  const reloaded = new Settings(dir);
  assert.equal(reloaded.get().language, "zh-CN");
  assert.equal(reloaded.get().timeFormat, "12");
  reloaded.set({ language: "unknown", timeFormat: "invalid" });
  assert.equal(reloaded.get().language, "zh-CN");
  assert.equal(reloaded.get().timeFormat, "12");
  reloaded.set({ timeFormat: "24" });
  assert.equal(reloaded.get().language, "zh-CN");
});
test("12-hour display handles midnight, noon, fractions and offsets without changing dates", () => {
  for (const [original, expected] of [
    ["2023-01-01 00:00:00 UTC-05:00", "2023-01-01 12:00:00 AM UTC-05:00"],
    ["2023-01-01 12:00:00 UTC+08:00", "2023-01-01 12:00:00 PM UTC+08:00"],
    [
      "2023:05:01 23:25:01.123456 -04:00",
      "2023:05:01 11:25:01.123456 PM -04:00",
    ],
    ["2023-11-05 01:30:00 UTC-04:00", "2023-11-05 01:30:00 AM UTC-04:00"],
  ]) {
    assert.equal(P.clock(original, "12"), expected);
    assert.equal(P.clock(original, "24"), original);
    assert.equal(P.clock(expected, "12"), expected);
  }
  for (const value of [
    "UTC-05:00",
    "12:30",
    "12:30:01",
    "24:03:04",
    "2030-02-03",
    "12-hour (AM/PM)",
  ])
    assert.equal(P.clock(value, "12"), value);
});
test("Chinese templates retain dynamic filenames and technical identifiers", () => {
  assert.equal(P.translate("Saved Save.jpg", "zh-CN"), "已保存 Save.jpg");
  assert.equal(P.translate("Apply to 3 files", "zh-CN"), "应用到 3 个文件");
  assert.equal(P.translate("Save", "en"), "Save");
  assert.equal(P.translate("DateTimeOriginal", "zh-CN"), "DateTimeOriginal");
  assert.equal(P.translate("constructor", "zh-CN"), "constructor");
  assert.equal(P.translate("Node.js", "zh-CN"), "Node.js");
  assert.equal(P.translate("0s", "zh-CN"), "0 秒");
  assert.equal(P.translate("2m 05s", "zh-CN"), "2 分 05 秒");
});
test("Chinese 12-hour dates use 上午/下午 without changing offsets, precision or English display", () => {
  const settings = { language: "zh-CN", timeFormat: "12" };
  for (const [source, expected] of [
    ["2025-04-27 00:07:01 UTC+00:00", "2025-04-27 上午 12:07:01 UTC+00:00"],
    ["2025-04-27 07:07:01 UTC+00:00", "2025-04-27 上午 07:07:01 UTC+00:00"],
    ["2025-04-27 12:07:01 UTC-05:00", "2025-04-27 下午 12:07:01 UTC-05:00"],
    ["2025:04:27 19:07:01.123456-04:00", "2025:04:27 下午 07:07:01.123456-04:00"],
  ]) {
    assert.equal(P.present(source, settings, true), expected);
    assert.equal(P.present(expected, settings, true), expected);
    assert.equal(P.present(source, { ...settings, timeFormat: "24" }, true), source);
  }
  assert.equal(P.clock("2025-04-27 07:07:01 PM UTC+00:00", "12", "zh-CN"), "2025-04-27 下午 07:07:01 UTC+00:00");
  assert.equal(P.clock("2025-04-27 下午 07:07:01 UTC+00:00", "12", "en"), "2025-04-27 07:07:01 PM UTC+00:00");
  assert.equal(P.translate("12 h apart", "zh-CN"), "相差 12 小时");
  assert.equal(P.translate("Still 2 h 30 min apart", "zh-CN"), "仍相差 2 小时 30 分钟");
  assert.equal(P.translate("Add more", "zh-CN"), "添加更多");
});

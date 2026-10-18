"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { tmpDir } = require("./helpers");
const { parseExifDate, toMs, makeMoment, momentText, momentWithZone, bestDate } = require("../src/main/lib/dates");
const { makeIgnore, DEFAULT_IGNORES } = require("../src/main/lib/ignore");
const { humanSize } = require("../src/main/lib/util");

test("EXIF dates parse with and without zones", () => {
  assert.equal(toMs(parseExifDate("2021:07:04 15:30:45-07:00")), Date.UTC(2021, 6, 4, 22, 30, 45));
  assert.equal(toMs(parseExifDate("2021:07:04 15:30:45Z")), Date.UTC(2021, 6, 4, 15, 30, 45));
  assert.equal(toMs(parseExifDate("2021:07:04 15:30:45")), new Date(2021, 6, 4, 15, 30, 45).getTime());
  assert.equal(parseExifDate("0000:00:00 00:00:00"), null);
  assert.equal(parseExifDate("not a date"), null);
  const m = makeMoment("2020:01:02 03:04:05", "050", "+08:00");
  assert.equal(momentText(m), "2020:01:02 03:04:05.050 +08:00");
  assert.equal(m.ms, Date.UTC(2020, 0, 1, 19, 4, 5, 50));
  assert.equal(momentWithZone(m), "2020:01:02 03:04:05.050+08:00");
});

test("bestDate prefers DateTimeOriginal for photos and Keys for videos", () => {
  const photo = bestDate({
    "EXIF:IFD0:ModifyDate": "2020:01:01 00:00:00",
    "EXIF:ExifIFD:DateTimeOriginal": "2019:01:01 00:00:00",
    "EXIF:ExifIFD:OffsetTime": "+05:00",
  });
  assert.equal(photo.tag, "ExifIFD:DateTimeOriginal");
  assert.equal(photo.moment.offset, "+05:00", "falls back to any offset, like main_exif_dates.py");
  const video = bestDate({ "QuickTime:CreateDate": "2018:01:01 00:00:00+00:00", "QuickTime:Keys:CreationDate": "2018:01:01 09:00:00+09:00" }, { movie: true });
  assert.equal(video.tag, "Keys:CreationDate");
  assert.equal(bestDate({ "QuickTime:CreateDate": "0000:00:00 00:00:00" }, { movie: true }), null);
});

test("system files are ignored by name and pattern", () => {
  const ignore = makeIgnore(DEFAULT_IGNORES);
  for (const n of [".DS_Store", "._photo.jpg", "Thumbs.db", "THUMBS.DB", ".Trash-1000", ".myfile-partial-abc-x.jpg"]) assert.ok(ignore(n), n);
  for (const n of ["photo.jpg", "DS_Store", "Icon"]) assert.ok(!ignore(n), n);
});

test("sizes use Finder's decimal units", () => {
  assert.equal(humanSize(999), "999 B");
  assert.equal(humanSize(1500), "1.50 KB");
  assert.equal(humanSize(2_500_000_000), "2.50 GB");
});

test("build-app renames Electron.app and its helpers to myFile", () => {
  // A stand-in for node_modules/electron/dist/Electron.app.
  const fake = tmpDir("fake-electron");
  const app = path.join(fake, "Electron.app", "Contents");
  const plist = (exe, id) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n\t<key>CFBundleExecutable</key>\n\t<string>${exe}</string>\n\t<key>CFBundleIdentifier</key>\n\t<string>${id}</string>\n\t<key>CFBundleName</key>\n\t<string>${exe}</string>\n\t<key>CFBundleURLTypes</key>\n\t<array>\n\t\t<dict>\n\t\t\t<key>CFBundleURLName</key>\n\t\t\t<string>Electron</string>\n\t\t</dict>\n\t</array>\n</dict>\n</plist>\n`;
  fs.mkdirSync(path.join(app, "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(app, "MacOS", "Electron"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(app, "Info.plist"), plist("Electron", "com.github.Electron"));
  fs.mkdirSync(path.join(app, "Resources"), { recursive: true });
  fs.writeFileSync(path.join(app, "Resources", "default_app.asar"), "x");
  fs.writeFileSync(path.join(app, "Resources", "electron.icns"), "x");
  for (const variant of ["", " (GPU)", " (Renderer)", " (Plugin)"]) {
    const h = path.join(app, "Frameworks", `Electron Helper${variant}.app`, "Contents");
    fs.mkdirSync(path.join(h, "MacOS"), { recursive: true });
    fs.writeFileSync(path.join(h, "MacOS", `Electron Helper${variant}`), "#!/bin/sh\n");
    fs.writeFileSync(path.join(h, "Info.plist"), plist(`Electron Helper${variant}`, "com.github.Electron.helper"));
  }
  const out = tmpDir("built");
  const root = path.join(__dirname, "..");
  execFileSync(process.execPath, [path.join(root, "scripts", "build-app.mjs"), "--out", out, "--skip-sign"], {
    env: { ...process.env, MYFILE_ELECTRON_APP: path.join(fake, "Electron.app") },
    stdio: "pipe",
  });
  const built = path.join(out, "myFile.app", "Contents");
  assert.ok(fs.existsSync(path.join(built, "MacOS", "myFile")));
  const info = fs.readFileSync(path.join(built, "Info.plist"), "utf8");
  assert.match(info, /<key>CFBundleName<\/key>\n\t<string>myFile<\/string>/);
  assert.match(info, /<key>CFBundleIdentifier<\/key>\n\t<string>io\.github\.zhengzihao2002\.myfile<\/string>/);
  assert.match(info, /<key>CFBundleIconFile<\/key>\n\t<string>myFile\.icns<\/string>/);
  assert.match(info, /<key>CFBundleURLName<\/key>\n\t\t\t<string>Electron<\/string>/, "nested keys untouched");
  for (const variant of ["", " (GPU)", " (Renderer)", " (Plugin)"]) {
    const h = path.join(built, "Frameworks", `myFile Helper${variant}.app`, "Contents");
    assert.ok(fs.existsSync(path.join(h, "MacOS", `myFile Helper${variant}`)), `helper${variant}`);
    assert.match(fs.readFileSync(path.join(h, "Info.plist"), "utf8"), new RegExp(`<string>myFile Helper${variant.replace(/[()]/g, "\\$&")}</string>`));
  }
  assert.ok(!fs.existsSync(path.join(built, "Resources", "default_app.asar")));
  assert.ok(fs.existsSync(path.join(built, "Resources", "myFile.icns")));
  assert.ok(fs.existsSync(path.join(built, "Resources", "app", "src", "main", "main.js")));
  assert.ok(fs.existsSync(path.join(built, "Resources", "exiftool", "exiftool")));
  assert.ok(fs.existsSync(path.join(built, "Resources", "exiftool", "lib", "Image", "ExifTool.pm")));
  const pkg = JSON.parse(fs.readFileSync(path.join(built, "Resources", "app", "package.json"), "utf8"));
  assert.equal(pkg.productName, "myFile");
  assert.equal(pkg.main, "src/main/main.js");
  assert.match(pkg.myfile.exiftool, /^\d+\.\d+/);
});

test("throttle never delivers an empty update after a newer one was already sent", async () => {
  const { throttle } = require("../src/main/lib/util");
  const got = [];
  const t = throttle((v) => got.push(v), 30);
  t(1); // immediate
  t(2); // scheduled
  await new Promise((r) => setTimeout(r, 40));
  t(3); // immediate (window passed); the old timer must not fire an empty update
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(got.every((v) => v !== null && v !== undefined), JSON.stringify(got));
  assert.deepEqual(got.slice(-1), [3]);
});

test("filesAtOnce: the user's number wins, automatic follows the slowest drive", () => {
  const { filesAtOnce } = require("../src/main/lib/util");
  const ssd = { solidState: true };
  const hdd = { solidState: false };
  assert.equal(filesAtOnce("auto", [ssd]), 4);
  assert.equal(filesAtOnce("auto", [ssd, hdd]), 1);
  assert.equal(filesAtOnce("auto", [{ solidState: null }]), 2);
  assert.equal(filesAtOnce("auto", []), 4);
  assert.equal(filesAtOnce(3, [hdd]), 3);
  assert.equal(filesAtOnce("8", [hdd]), 8);
  assert.equal(filesAtOnce(0, [ssd]), 4, "0 is not a valid choice, so automatic applies");
  assert.equal(filesAtOnce(99, [ssd]), 16);
});

#!/usr/bin/env node
// Assembles myFile.app from the Electron runtime in node_modules.
//
// This is what electron-packager does, done by hand so there is nothing extra
// to download: clone Electron.app, rename it and its helper apps to myFile,
// rewrite the Info.plist files, drop in our code, ExifTool and the icon, then
// sign the bundle ad hoc so macOS will run it. Because every file comes from
// this Mac's own downloads, the app carries no quarantine flag.
//
//   node scripts/build-app.mjs [--out <dir>] [--skip-sign]

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_NAME = "myFile";
const BUNDLE_ID = "io.github.zhengzihao2002.myfile";
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const args = process.argv.slice(2);
const outDir = argValue("--out") ? path.resolve(argValue("--out")) : ROOT;
const skipSign = args.includes("--skip-sign");
const isMac = process.platform === "darwin";

const electronApp = process.env.MYFILE_ELECTRON_APP || path.join(ROOT, "node_modules", "electron", "dist", "Electron.app");
const exiftoolDir = path.join(ROOT, "node_modules", "exiftool-vendored.pl", "bin");
const privatePerl = path.join(ROOT, ".runtime", "perl");
const appPath = path.join(outDir, `${APP_NAME}.app`);
const contents = path.join(appPath, "Contents");
const resources = path.join(contents, "Resources");
const frameworks = path.join(contents, "Frameworks");

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function log(message) {
  console.log(`    ${message}`);
}

function run(cmd, cmdArgs, options = {}) {
  return execFileSync(cmd, cmdArgs, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...options });
}

// Copies a directory tree. On APFS `cp -c` makes a clone, which shares the
// data blocks with the source and so takes no extra disk space.
function copyTree(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (isMac) {
    try {
      run("/bin/cp", ["-Rc", src, dest]);
      return;
    } catch {
      fs.rmSync(dest, { recursive: true, force: true });
      run("/usr/bin/ditto", [src, dest]);
      return;
    }
  }
  fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
}

// ---------------------------------------------------------------------------
// Info.plist editing. On macOS the file is first normalised to XML with
// plutil; then top-level string keys are replaced or added.
// ---------------------------------------------------------------------------

function escapeXml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function setPlistStrings(xml, values) {
  let out = xml;
  for (const [key, value] of Object.entries(values)) {
    const entry = `<key>${key}</key>\n\t<string>${escapeXml(value)}</string>`;
    // Top-level keys are indented by exactly one tab in plutil's XML output.
    const existing = new RegExp(`(^|\\n)\\t<key>${key}</key>\\s*<string>[^<]*</string>`);
    if (existing.test(out)) {
      out = out.replace(existing, (_m, lead) => `${lead}\t${entry}`);
    } else {
      const end = out.lastIndexOf("</dict>");
      if (end < 0) throw new Error("Info.plist has no top-level <dict>");
      out = `${out.slice(0, end)}\t${entry}\n${out.slice(end)}`;
    }
  }
  return out;
}

function editPlist(file, values) {
  if (isMac) run("/usr/bin/plutil", ["-convert", "xml1", file]);
  const xml = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, setPlistStrings(xml, values));
  if (isMac) run("/usr/bin/plutil", ["-lint", file]);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function build() {
  if (!fs.existsSync(electronApp)) {
    throw new Error(`Electron runtime not found at ${electronApp}. Run "bash install.sh" first.`);
  }
  if (!fs.existsSync(path.join(exiftoolDir, "exiftool"))) {
    throw new Error("ExifTool not found in node_modules. Run \"bash install.sh\" first.");
  }

  fs.rmSync(appPath, { recursive: true, force: true });
  copyTree(electronApp, appPath);
  log(`copied the Electron runtime${isMac ? " (APFS clone, no extra space)" : ""}`);

  // Main executable and Info.plist.
  fs.renameSync(path.join(contents, "MacOS", "Electron"), path.join(contents, "MacOS", APP_NAME));
  editPlist(path.join(contents, "Info.plist"), {
    CFBundleExecutable: APP_NAME,
    CFBundleName: APP_NAME,
    CFBundleDisplayName: APP_NAME,
    CFBundleIdentifier: BUNDLE_ID,
    CFBundleIconFile: `${APP_NAME}.icns`,
    CFBundleShortVersionString: pkg.version,
    CFBundleVersion: pkg.version,
    NSHumanReadableCopyright: "Built locally from source. Everything it uses lives in its own folder.",
    LSApplicationCategoryType: "public.app-category.productivity",
    NSDesktopFolderUsageDescription: "myFile reads and updates the files and folders you give it.",
    NSDocumentsFolderUsageDescription: "myFile reads and updates the files and folders you give it.",
    NSDownloadsFolderUsageDescription: "myFile reads and updates the files and folders you give it.",
    NSRemovableVolumesUsageDescription: "myFile reads and updates files on drives you choose.",
    NSNetworkVolumesUsageDescription: "myFile reads and updates files on network drives you choose.",
  });

  // Helper apps. Electron looks for "<CFBundleName> Helper*.app", so they are
  // renamed to match; Activity Monitor then shows "myFile Helper (Renderer)".
  const helpers = [
    ["", "helper"],
    [" (GPU)", "helper.gpu"],
    [" (Renderer)", "helper.renderer"],
    [" (Plugin)", "helper.plugin"],
  ];
  for (const [variant, idSuffix] of helpers) {
    const oldName = `Electron Helper${variant}`;
    const newName = `${APP_NAME} Helper${variant}`;
    const oldDir = path.join(frameworks, `${oldName}.app`);
    if (!fs.existsSync(oldDir)) continue;
    const macos = path.join(oldDir, "Contents", "MacOS");
    fs.renameSync(path.join(macos, oldName), path.join(macos, newName));
    editPlist(path.join(oldDir, "Contents", "Info.plist"), {
      CFBundleExecutable: newName,
      CFBundleName: newName,
      CFBundleDisplayName: newName,
      CFBundleIdentifier: `${BUNDLE_ID}.${idSuffix}`,
    });
    fs.renameSync(oldDir, path.join(frameworks, `${newName}.app`));
  }
  log("renamed the app and its helpers to myFile");

  // Resources: our icon instead of Electron's, no default app.
  fs.rmSync(path.join(resources, "default_app.asar"), { force: true });
  fs.rmSync(path.join(resources, "electron.icns"), { force: true });
  fs.copyFileSync(path.join(ROOT, "assets", "icon.icns"), path.join(resources, `${APP_NAME}.icns`));

  // Our code, loaded by Electron from Resources/app.
  const appDir = path.join(resources, "app");
  fs.mkdirSync(appDir, { recursive: true });
  fs.cpSync(path.join(ROOT, "src"), path.join(appDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(appDir, "assets"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "assets", "icon.png"), path.join(appDir, "assets", "icon.png"));
  const exiftoolVersion = readExiftoolVersion();
  fs.writeFileSync(
    path.join(appDir, "package.json"),
    JSON.stringify(
      {
        name: pkg.name,
        productName: APP_NAME,
        version: pkg.version,
        description: pkg.description,
        main: pkg.main,
        myfile: {
          builtAt: new Date().toISOString(),
          electron: readJson(path.join(ROOT, "node_modules", "electron", "package.json"))?.version ?? null,
          exiftool: exiftoolVersion,
        },
      },
      null,
      2,
    ),
  );
  log("added the myFile code");

  // ExifTool, plus a private perl if this Mac has none.
  const etDest = path.join(resources, "exiftool");
  fs.mkdirSync(etDest, { recursive: true });
  fs.copyFileSync(path.join(exiftoolDir, "exiftool"), path.join(etDest, "exiftool"));
  fs.chmodSync(path.join(etDest, "exiftool"), 0o755);
  copyTree(path.join(exiftoolDir, "lib"), path.join(etDest, "lib"));
  if (fs.existsSync(path.join(privatePerl, "bin", "perl"))) {
    copyTree(privatePerl, path.join(resources, "perl"));
    log("added ExifTool and a private perl");
  } else {
    log(`added ExifTool ${exiftoolVersion ?? ""}`.trim());
  }

  if (isMac) {
    // Quarantine and Finder info xattrs would make codesign refuse the bundle.
    // Some attributes (com.apple.provenance) are protected on newer macOS and
    // can't be removed; that's fine, codesign doesn't mind those.
    try {
      run("/usr/bin/xattr", ["-cr", appPath]);
    } catch {
      for (const attr of ["com.apple.quarantine", "com.apple.FinderInfo", "com.apple.ResourceFork"]) {
        try {
          run("/usr/bin/xattr", ["-dr", attr, appPath]);
        } catch {
          // not present
        }
      }
    }
    if (!skipSign) sign();
    // A fresh mtime makes Finder and the Dock pick up the new icon.
    const now = new Date();
    fs.utimesSync(appPath, now, now);
  }

  console.log(`    ✓ ${appPath}`);
}

function sign() {
  // Ad-hoc signature: no Apple account involved. Apple silicon requires every
  // executable to be signed, and editing Info.plist invalidated Electron's.
  try {
    run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath]);
  } catch (err) {
    throw new Error(`codesign failed:\n${err.stderr || err.message}`);
  }
  try {
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
    log("signed (ad hoc) and verified");
  } catch (err) {
    log(`signed, but verification reported: ${(err.stderr || err.message).trim()}`);
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readExiftoolVersion() {
  try {
    const text = fs.readFileSync(path.join(exiftoolDir, "exiftool"), "utf8");
    const match = text.match(/\$version\s*=\s*['"]([\d.]+)['"]/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    build();
  } catch (err) {
    console.error(`\n    ${err.message}`);
    process.exit(1);
  }
}

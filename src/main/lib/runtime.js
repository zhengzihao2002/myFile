"use strict";

// Works out where myFile keeps things at run time.
//
// The app normally sits in its project folder (next to .myfile-root). Then
// all app data goes to <project>/.runtime/appdata, so deleting the project
// folder deletes it too. If someone moves myFile.app elsewhere, it still
// works, but keeps its data in a temporary folder that is removed on quit.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MARKER = ".myfile-root";
const BUNDLE_ID = "io.github.zhengzihao2002.myfile";

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function findProjectRoot({ isPackaged, execPath, mainDir }) {
  if (isPackaged) {
    // .../<project>/myFile.app/Contents/MacOS/myFile
    const bundle = path.resolve(execPath, "..", "..", "..");
    const parent = path.dirname(bundle);
    return exists(path.join(parent, MARKER)) ? parent : null;
  }
  // Running from source: mainDir is src/main
  const root = path.resolve(mainDir, "..", "..");
  return exists(path.join(root, MARKER)) ? root : null;
}

function resolveRuntime({ isPackaged = false, execPath = process.execPath, resourcesPath = "", mainDir = path.join(__dirname, "..") } = {}) {
  const projectRoot = findProjectRoot({ isPackaged, execPath, mainDir });

  let dataDir = process.env.MYFILE_DATA_DIR || null;
  let ephemeral = false;
  if (!dataDir) {
    if (projectRoot) dataDir = path.join(projectRoot, ".runtime", "appdata");
    else {
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "myFile-"));
      ephemeral = true;
    }
  }
  fs.mkdirSync(dataDir, { recursive: true });

  const libDir = path.join(mainDir, "lib");
  const perlCandidates = [
    isPackaged && resourcesPath ? path.join(resourcesPath, "perl", "bin", "perl") : null,
    projectRoot ? path.join(projectRoot, ".runtime", "perl", "bin", "perl") : null,
    "/usr/bin/perl",
    "/usr/local/bin/perl",
    "/opt/homebrew/bin/perl",
  ].filter(Boolean);
  const perl = perlCandidates.find(exists) || "perl";

  const exiftool = isPackaged && resourcesPath
    ? path.join(resourcesPath, "exiftool", "exiftool")
    : path.join(projectRoot || path.resolve(mainDir, "..", ".."), "node_modules", "exiftool-vendored.pl", "bin", "exiftool");

  return {
    bundleId: BUNDLE_ID,
    isPackaged,
    projectRoot,
    dataDir,
    ephemeral,
    tmpDir: path.join(dataDir, "tmp"),
    previewDir: path.join(dataDir, "previews"),
    historyDir: path.join(dataDir, "history"),
    perl,
    exiftool,
    exiftoolFound: exists(exiftool),
    libDir,
  };
}

module.exports = { resolveRuntime, MARKER, BUNDLE_ID };

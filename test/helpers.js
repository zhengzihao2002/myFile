"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// A 16×12 JPEG with no metadata.
const JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAMABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCrRRRXkHuH/9k=";

function makeJpeg(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(JPEG_BASE64, "base64"));
  return file;
}

function box(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, payload]);
}

// The smallest QuickTime file ExifTool will write to: ftyp, moov/mvhd, empty mdat.
function makeMovie(file, brand = "qt  ") {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(600, 12); // timescale
  mvhd.writeUInt32BE(0x00010000, 20); // rate
  mvhd.writeUInt16BE(0x0100, 24); // volume
  const matrix = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
  matrix.forEach((v, i) => mvhd.writeUInt32BE(v, 36 + i * 4));
  mvhd.writeUInt32BE(2, 96); // next track id
  const ftyp = box("ftyp", Buffer.concat([Buffer.from(brand, "latin1"), Buffer.alloc(4), Buffer.from(brand, "latin1")]));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([ftyp, box("moov", box("mvhd", mvhd)), box("mdat", Buffer.alloc(0))]));
  return file;
}

function tmpDir(name = "t") {
  const base = path.join(__dirname, ".tmp");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, `${name}-`));
}

/** Creates files from { "a/b.txt": "content", "c/": null, "p.jpg": "jpeg", "v.mov": "mov" }. */
function makeTree(root, spec) {
  for (const [rel, content] of Object.entries(spec)) {
    const full = path.join(root, rel);
    if (rel.endsWith("/")) fs.mkdirSync(full, { recursive: true });
    else if (content === "jpeg") makeJpeg(full);
    else if (content === "mov") makeMovie(full);
    else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }
  return root;
}

function setMtime(file, ms) {
  fs.utimesSync(file, ms / 1000, ms / 1000);
}

let shared = null;

/** A backend context like the app's, with its own data folder and a fake Trash. */
function testContext() {
  if (shared) return shared;
  const dataDir = tmpDir("data");
  process.env.MYFILE_DATA_DIR = dataDir;
  const { resolveRuntime } = require("../src/main/lib/runtime");
  const { ExifTool } = require("../src/main/lib/exiftool");
  const { createContext, createHandlers } = require("../src/main/handlers");
  const runtime = resolveRuntime({ isPackaged: false, mainDir: path.join(__dirname, "..", "src", "main") });
  const et = new ExifTool({ perl: runtime.perl, script: runtime.exiftool });
  const trashDir = path.join(dataDir, "trash");
  const trashed = [];
  const ctx = createContext({
    runtime,
    et,
    appVersion: "test",
    fileUrl: (p) => pathToFileURL(p).href,
    trash: async (p) => {
      fs.mkdirSync(trashDir, { recursive: true });
      const dest = path.join(trashDir, `${trashed.length}-${path.basename(p)}`);
      fs.renameSync(p, dest);
      trashed.push(p);
    },
  });
  const handlers = createHandlers(ctx);
  const task = { signal: undefined, progress: () => {} };
  const call = async (name, payload) => {
    const out = await handlers[name](payload, task);
    return out;
  };
  shared = { ctx, et, handlers, call, task, trashed, dataDir };
  return shared;
}

async function readTags(et, file, tags) {
  const [row] = await et.readJson([file], ["-s", ...tags.map((t) => `-${t}`)]);
  return row || {};
}

module.exports = { makeJpeg, makeMovie, makeTree, tmpDir, setMtime, testContext, readTags, os };

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pipeline } = require("node:stream/promises");
const { CancelledError } = require("./util");

const IS_MAC = process.platform === "darwin";

function runCp(args, { signal, dest, onBytes }) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/cp", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let reported = 0;
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    // cp gives no progress, so watch the destination grow.
    const poll = setInterval(() => {
      fs.stat(dest, (err, st) => {
        if (err || !onBytes) return;
        if (st.size > reported) {
          onBytes(st.size - reported);
          reported = st.size;
        }
      });
    }, 250);
    const onAbort = () => child.kill("SIGKILL");
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      clearInterval(poll);
      reject(err);
    });
    child.on("close", (code) => {
      clearInterval(poll);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (signal && signal.aborted) return reject(new CancelledError());
      if (code === 0) resolve(reported);
      else reject(new Error(stderr.trim().replace(/^cp:\s*/, "") || `cp exited with ${code}`));
    });
  });
}

/**
 * Copies one file with its contents and permissions, and (unless
 * `xattrs: false`) its extended attributes such as Finder tags.
 *   clone   try an APFS clone (same volume only): instant, no extra space
 *   xattrs  false for exFAT/FAT drives, which can't store extended
 *           attributes; macOS would otherwise add a "._name" file per copy
 * onBytes(n) reports progress while the copy runs.
 */
async function copyFileExact(src, dest, { signal, onBytes, size, clone = true, xattrs = true } = {}) {
  if (IS_MAC) {
    let reported = 0;
    const counted = (n) => {
      reported += n;
      if (onBytes) onBytes(n);
    };
    const flags = `-p${xattrs ? "" : "X"}`;
    try {
      await runCp(clone ? [`${flags}c`, src, dest] : [flags, src, dest], { signal, dest, onBytes: counted });
    } catch (err) {
      if (err instanceof CancelledError || !clone) throw err;
      // The volume refused a clone; copy normally.
      await fs.promises.rm(dest, { force: true });
      if (reported && onBytes) onBytes(-reported);
      reported = 0;
      await runCp([flags, src, dest], { signal, dest, onBytes: counted });
    }
    if (size !== undefined && reported < size && onBytes) onBytes(size - reported);
    return;
  }
  const st = await fs.promises.stat(src);
  const read = fs.createReadStream(src);
  if (onBytes) read.on("data", (chunk) => onBytes(chunk.length));
  await pipeline(read, fs.createWriteStream(dest, { mode: st.mode }), { signal });
}

/** Free and total bytes on the volume holding `p` (or its nearest existing parent). */
async function diskSpace(p) {
  let dir = p;
  for (let i = 0; i < 64; i++) {
    try {
      const s = await fs.promises.statfs(dir);
      return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return { free: null, total: null };
}

module.exports = { copyFileExact, diskSpace };

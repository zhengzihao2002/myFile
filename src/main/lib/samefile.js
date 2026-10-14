"use strict";

const fs = require("node:fs");
const { checkCancel } = require("./util");

const CHUNK = 1024 * 1024;

/**
 * True if two files have identical bytes. Reads both in 1 MB chunks and stops
 * at the first difference. onBytes(n) reports progress (bytes of one file).
 */
async function sameContent(a, b, { signal, onBytes } = {}) {
  const [fa, fb] = await Promise.all([fs.promises.open(a, "r"), fs.promises.open(b, "r")]);
  try {
    const [sa, sb] = await Promise.all([fa.stat(), fb.stat()]);
    if (sa.size !== sb.size) return false;
    const bufA = Buffer.allocUnsafe(CHUNK);
    const bufB = Buffer.allocUnsafe(CHUNK);
    let pos = 0;
    while (pos < sa.size) {
      checkCancel(signal);
      const [ra, rb] = await Promise.all([fa.read(bufA, 0, CHUNK, pos), fb.read(bufB, 0, CHUNK, pos)]);
      if (ra.bytesRead !== rb.bytesRead) return false;
      if (ra.bytesRead === 0) break;
      if (bufA.compare(bufB, 0, rb.bytesRead, 0, ra.bytesRead) !== 0) return false;
      pos += ra.bytesRead;
      if (onBytes) onBytes(ra.bytesRead);
    }
    return true;
  } finally {
    await Promise.all([fa.close(), fb.close()]);
  }
}

/**
 * Describes how two same-size files differ: where the first different byte is
 * and how many bytes differ. Scans at most `maxBytes` from the start
 * (partial: true if it stopped early).
 */
async function diffContent(a, b, { signal, maxBytes = 128 * CHUNK } = {}) {
  const [fa, fb] = await Promise.all([fs.promises.open(a, "r"), fs.promises.open(b, "r")]);
  try {
    const size = (await fa.stat()).size;
    const bufA = Buffer.allocUnsafe(CHUNK);
    const bufB = Buffer.allocUnsafe(CHUNK);
    let pos = 0;
    let first = -1;
    let differing = 0;
    const limit = Math.min(size, maxBytes);
    while (pos < limit) {
      checkCancel(signal);
      const [ra, rb] = await Promise.all([fa.read(bufA, 0, CHUNK, pos), fb.read(bufB, 0, CHUNK, pos)]);
      const n = Math.min(ra.bytesRead, rb.bytesRead);
      if (n === 0) break;
      if (bufA.compare(bufB, 0, n, 0, n) !== 0) {
        for (let i = 0; i < n; i++) {
          if (bufA[i] !== bufB[i]) {
            if (first < 0) first = pos + i;
            differing++;
          }
        }
      }
      pos += n;
    }
    return { firstOffset: first, differingBytes: differing, partial: pos < size, scannedBytes: pos };
  } finally {
    await Promise.all([fa.close(), fb.close()]);
  }
}

module.exports = { sameContent, diffContent };

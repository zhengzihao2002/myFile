"use strict";

const path = require("node:path");

class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
    this.code = "CANCELLED";
  }
}

// A user-facing error: its message is shown as-is in the app.
class UserError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "UserError";
    this.code = "USER";
    this.details = details;
  }
}

function checkCancel(signal) {
  if (signal && signal.aborted) throw new CancelledError();
}

// Runs fn over items with at most `limit` in flight. Results keep input order.
async function mapLimit(items, limit, fn, signal) {
  const results = new Array(items.length);
  let next = 0;
  const workers = [];
  const count = Math.max(1, Math.min(limit, items.length));
  for (let w = 0; w < count; w++) {
    workers.push(
      (async () => {
        while (true) {
          checkCancel(signal);
          const i = next++;
          if (i >= items.length) return;
          results[i] = await fn(items[i], i);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

// Calls fn at most once per `ms`, always delivering the latest value; flush() sends it now.
function throttle(fn, ms = 120) {
  let last = 0;
  let pending = null;
  let timer = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    // A newer call may already have delivered this value.
    if (pending === null) return;
    last = Date.now();
    const value = pending;
    pending = null;
    fn(value);
  };
  const call = (value) => {
    pending = value;
    const wait = ms - (Date.now() - last);
    if (wait <= 0) fire();
    else if (!timer) timer = setTimeout(fire, wait);
  };
  call.flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (pending !== null) fire();
  };
  return call;
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  const negative = bytes < 0;
  let n = Math.abs(bytes);
  if (n < 1000) return `${negative ? "-" : ""}${n} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let i = -1;
  do {
    n /= 1000;
    i++;
  } while (n >= 1000 && i < units.length - 1);
  const digits = n < 10 ? 2 : n < 100 ? 1 : 0;
  return `${negative ? "-" : ""}${n.toFixed(digits)} ${units[i]}`;
}

// Relative paths are always "/"-separated and Unicode NFC, so that the same
// name on an HFS+ drive (stored decomposed) and on APFS compares equal.
function relKey(rel) {
  return rel.normalize("NFC");
}

function joinRel(parent, name) {
  return parent ? `${parent}/${name}` : name;
}

function relToAbs(root, rel) {
  return rel ? path.join(root, ...rel.split("/")) : root;
}

function parentRel(rel) {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

function depthOf(rel) {
  if (!rel) return 0;
  let d = 1;
  for (let i = 0; i < rel.length; i++) if (rel[i] === "/") d++;
  return d;
}

function extOf(name) {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function newId(prefix = "") {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function errText(err) {
  if (!err) return "Unknown error";
  if (err.code === "ENOENT") return "No such file or folder";
  if (err.code === "EACCES" || err.code === "EPERM") return "Permission denied";
  if (err.code === "ENOSPC") return "Not enough free space";
  if (err.code === "EROFS") return "The disk is read-only";
  return err.message || String(err);
}

module.exports = {
  CancelledError,
  UserError,
  checkCancel,
  mapLimit,
  throttle,
  humanSize,
  relKey,
  joinRel,
  relToAbs,
  parentRel,
  depthOf,
  extOf,
  isInside,
  newId,
  errText,
};

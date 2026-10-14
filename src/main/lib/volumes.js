"use strict";

// Facts about the disk a folder lives on: its name and model, format (APFS,
// exFAT, FAT32 ...), whether it is an external drive, an SSD, read-only.
// FileSync uses them to treat external SSDs such as a Samsung T7 or T9
// properly: exFAT can't hold extended attributes, FAT32 can't hold files over
// 4 GB, timestamps are coarser, and drives can be unplugged mid-copy.
//
// On macOS the facts come from `diskutil info -plist`, which every Mac has.

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const IS_MAC = process.platform === "darwin";
const CACHE_MS = 15000;

// What each format can and can't do.
const TRAITS = {
  apfs: { label: "APFS", xattrs: true, granularityMs: 0, restrictNames: false, maxFileSize: null },
  hfs: { label: "Mac OS Extended", xattrs: true, granularityMs: 1000, restrictNames: false, maxFileSize: null },
  exfat: { label: "ExFAT", xattrs: false, granularityMs: 10, restrictNames: true, maxFileSize: null },
  msdos: { label: "FAT32", xattrs: false, granularityMs: 2000, restrictNames: true, maxFileSize: 4294967295 },
  ntfs: { label: "NTFS", xattrs: false, granularityMs: 0, restrictNames: true, maxFileSize: null },
  smbfs: { label: "Network (SMB)", xattrs: true, granularityMs: 1000, restrictNames: true, maxFileSize: null },
  unknown: { label: "Unknown format", xattrs: true, granularityMs: 0, restrictNames: false, maxFileSize: null },
};
const LINUX_TYPES = { vfat: "msdos", fat: "msdos", msdos: "msdos", exfat: "exfat", ntfs: "ntfs", ntfs3: "ntfs", hfsplus: "hfs", apfs: "apfs" };

// Items macOS and Windows keep at the top of a drive. myFile never removes
// them, even with "include system files" and mirroring turned on.
const VOLUME_SYSTEM_ITEMS = new Set([
  ".Spotlight-V100", ".fseventsd", ".Trashes", ".TemporaryItems", ".DocumentRevisions-V100",
  ".VolumeIcon.icns", ".apdisk", ".com.apple.timemachine.donotpresent", ".PKInstallSandboxManager",
  "System Volume Information", "$RECYCLE.BIN", ".Trash-1000",
].map((n) => n.toLowerCase()));

function isVolumeSystemItem(name) {
  return VOLUME_SYSTEM_ITEMS.has(String(name).toLowerCase());
}

// ---------------------------------------------------------------------------
// Minimal XML property-list reader for diskutil's output
// ---------------------------------------------------------------------------

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

function parsePlist(xml) {
  const tokens = xml.match(/<(\/?)(dict|array|key|string|integer|real|true|false|date|data)(\/?)>|[^<]+/g) || [];
  let i = 0;
  const skipText = () => {
    while (i < tokens.length && tokens[i][0] !== "<") i++;
  };
  const readText = (tag) => {
    let text = "";
    while (i < tokens.length && tokens[i] !== `</${tag}>`) text += tokens[i++];
    i++; // closing tag
    return decodeEntities(text);
  };
  const value = () => {
    skipText();
    const tok = tokens[i++];
    if (!tok) return undefined;
    const m = /^<(\/?)(\w+)(\/?)>$/.exec(tok);
    if (!m) return undefined;
    const [, , tag, selfClosing] = m;
    if (tag === "true") return true;
    if (tag === "false") return false;
    if (selfClosing) return tag === "dict" ? {} : tag === "array" ? [] : "";
    if (tag === "dict") {
      const obj = {};
      while (true) {
        skipText();
        if (tokens[i] === "</dict>") {
          i++;
          return obj;
        }
        if (tokens[i] !== "<key>") return obj;
        i++;
        const key = readText("key");
        obj[key] = value();
      }
    }
    if (tag === "array") {
      const arr = [];
      while (true) {
        skipText();
        if (tokens[i] === "</array>") {
          i++;
          return arr;
        }
        if (i >= tokens.length) return arr;
        arr.push(value());
      }
    }
    const text = readText(tag);
    if (tag === "integer") return Number(text);
    if (tag === "real") return Number(text);
    return text.trim();
  };
  // Skip the XML header and the <plist> wrapper.
  const start = tokens.findIndex((t) => t === "<dict>" || t === "<array>");
  if (start < 0) return null;
  i = start;
  return value();
}

function diskutil(args) {
  return new Promise((resolve) => {
    execFile("/usr/sbin/diskutil", args, { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(parsePlist(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

// ---------------------------------------------------------------------------

/** "Mounted on" column of `df -P` output (the name may contain spaces). */
function parseDfMountPoint(stdout) {
  const lines = String(stdout).trim().split("\n");
  const m = /\d+%\s+(.+)$/.exec(lines[lines.length - 1] || "");
  return m ? m[1].trim() : null;
}

/**
 * macOS: ask df which volume holds `p`. Folders in the home folder live on the
 * "Macintosh HD - Data" volume (/System/Volumes/Data), which is joined to the
 * read-only system volume at "/", so comparing device numbers alone lands on
 * "/Users" and describes the wrong volume.
 */
function dfMountPoint(p) {
  return new Promise((resolve) => {
    execFile("/bin/df", ["-P", "-k", p], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(null);
      const mp = parseDfMountPoint(stdout);
      resolve(mp && path.isAbsolute(mp) ? mp : null);
    });
  });
}

/** The mount point of the volume holding `p` (walks up until the device changes). */
async function mountPointOf(p) {
  let cur = path.resolve(p);
  let st;
  while (true) {
    try {
      st = await fs.promises.stat(cur);
      break;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return cur;
      cur = parent;
    }
  }
  // External drives are mounted at /Volumes/<name>.
  const vol = /^\/Volumes\/[^/]+/.exec(cur);
  if (IS_MAC && vol) return vol[0];
  if (IS_MAC) {
    const mp = await dfMountPoint(cur);
    if (mp) return mp;
  }
  while (true) {
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    let pst;
    try {
      pst = await fs.promises.stat(parent);
    } catch {
      return cur;
    }
    if (pst.dev !== st.dev) return cur;
    cur = parent;
  }
}

function linuxFsType(mountPoint) {
  try {
    const lines = fs.readFileSync("/proc/mounts", "utf8").split("\n");
    for (const line of lines) {
      const [, mnt, type] = line.split(" ");
      if (mnt && mnt.replace(/\\040/g, " ") === mountPoint) return LINUX_TYPES[type] || type;
    }
  } catch {
    // not Linux
  }
  return "unknown";
}

const cache = new Map();

async function describe(mountPoint) {
  const base = {
    mountPoint,
    name: path.basename(mountPoint) || mountPoint,
    model: null,
    fsType: "unknown",
    fsName: null,
    external: IS_MAC ? mountPoint.startsWith("/Volumes/") : false,
    ejectable: false,
    solidState: null,
    protocol: null,
    writable: true,
    caseSensitive: false,
  };
  if (IS_MAC) {
    const d = await diskutil(["info", "-plist", mountPoint]);
    if (d) {
      base.name = d.VolumeName || base.name;
      base.fsType = String(d.FilesystemType || "unknown").toLowerCase();
      base.fsName = d.FilesystemName || d.FilesystemUserVisibleName || null;
      base.external = d.Internal === false || Boolean(d.RemovableMediaOrExternalDevice);
      base.ejectable = Boolean(d.Ejectable) || (base.external && mountPoint.startsWith("/Volumes/"));
      base.writable = d.WritableVolume !== false;
      base.caseSensitive = /case-sensitive/i.test(String(d.FilesystemName || d.FilesystemUserVisibleName || ""));
      base.solidState = typeof d.SolidState === "boolean" ? d.SolidState : null;
      base.protocol = d.BusProtocol || null;
      // The drive's model ("Samsung PSSD T7") lives on the whole physical disk.
      let whole = d.ParentWholeDisk || null;
      if (Array.isArray(d.APFSPhysicalStores) && d.APFSPhysicalStores.length && d.APFSPhysicalStores[0].APFSPhysicalStore) {
        whole = String(d.APFSPhysicalStores[0].APFSPhysicalStore).replace(/s\d+$/, "");
      }
      if (whole) {
        const w = await diskutil(["info", "-plist", whole]);
        if (w) {
          if (w.MediaName) base.model = String(w.MediaName).replace(/\s+Media$/i, "").trim() || null;
          if (base.solidState === null && typeof w.SolidState === "boolean") base.solidState = w.SolidState;
          if (!base.protocol && w.BusProtocol) base.protocol = w.BusProtocol;
        }
      }
    }
  } else {
    base.fsType = linuxFsType(mountPoint);
  }
  const traits = TRAITS[base.fsType] || TRAITS.unknown;
  // macOS can read NTFS but not write it without extra software.
  if (base.fsType === "ntfs" && IS_MAC) base.writable = false;
  return {
    ...base,
    fsLabel: base.fsName || traits.label,
    xattrs: traits.xattrs,
    granularityMs: traits.granularityMs,
    restrictNames: traits.restrictNames,
    maxFileSize: traits.maxFileSize,
  };
}

/** Can this user change things in `p` (or, if it doesn't exist yet, the closest folder above it)? */
async function canWriteAt(p) {
  let cur = path.resolve(p);
  while (true) {
    try {
      const st = await fs.promises.stat(cur);
      if (!st.isDirectory()) cur = path.dirname(cur);
      break;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  try {
    await fs.promises.access(cur, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Volume facts for the disk holding `p`, cached for a few seconds.
 * `volumeWritable` is about the disk; `writable` also needs this folder's
 * permissions to allow changes.
 */
async function info(p) {
  const mountPoint = await mountPointOf(p);
  let hit = cache.get(mountPoint);
  if (!hit || Date.now() - hit.at >= CACHE_MS) {
    hit = { at: Date.now(), value: await describe(mountPoint) };
    cache.set(mountPoint, hit);
  }
  const pathWritable = await canWriteAt(p);
  return { ...hit.value, volumeWritable: hit.value.writable, pathWritable, writable: hit.value.writable && pathWritable };
}

/** Short description for the UI: "Samsung PSSD T7 · ExFAT · USB". */
function brief(v) {
  if (!v) return null;
  return {
    name: v.name,
    model: v.model,
    fsLabel: v.fsLabel,
    external: v.external,
    solidState: v.solidState,
    protocol: v.protocol,
    writable: v.writable,
    volumeWritable: v.volumeWritable,
    mountPoint: v.mountPoint,
  };
}

/** Characters exFAT and FAT can't store, plus names Windows trims. */
function nameProblem(name) {
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 32) return "contains a control character";
    if ('"*:<>?\\|'.includes(name[i])) return `contains “${name[i]}”`;
  }
  if (/[. ]$/.test(name)) return "ends with a dot or space";
  return null;
}

function forget(mountPoint) {
  cache.delete(mountPoint);
}

/** Safely ejects an external drive (like Finder's Eject). */
function eject(mountPoint) {
  return new Promise((resolve, reject) => {
    if (!IS_MAC) return reject(new Error("Ejecting drives is only available on macOS."));
    if (!/^\/Volumes\/[^/]+$/.test(mountPoint)) return reject(new Error("Only drives under /Volumes can be ejected."));
    execFile("/usr/sbin/diskutil", ["eject", mountPoint], { timeout: 60000 }, (err, _stdout, stderr) => {
      forget(mountPoint);
      if (err) reject(new Error(String(stderr || err.message).trim() || "The drive couldn't be ejected. Is a file on it still open?"));
      else resolve(true);
    });
  });
}

module.exports = { info, brief, mountPointOf, parseDfMountPoint, parsePlist, nameProblem, isVolumeSystemItem, eject, forget, TRAITS };

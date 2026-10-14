"use strict";

// FileSync on external drives (Samsung T7/T9 and friends), using fake drive
// descriptions so each format's rules can be checked on any machine.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTree, tmpDir, testContext, setMtime } = require("./helpers");
const realVolumes = require("../src/main/lib/volumes");

const { ctx, et, call, trashed } = testContext();
test.after(() => et.close());

const T1 = Date.UTC(2022, 2, 3, 4, 5, 6);

function fakeVolumes(byRoot) {
  return {
    ...realVolumes,
    async info(p) {
      for (const [root, v] of Object.entries(byRoot)) {
        if (path.resolve(p) === root || path.resolve(p).startsWith(`${root}${path.sep}`)) {
          return { name: path.basename(root), model: null, external: true, ejectable: true, solidState: true, protocol: "USB", writable: true, caseSensitive: false, xattrs: true, granularityMs: 0, restrictNames: false, maxFileSize: null, fsType: "apfs", fsLabel: "APFS", mountPoint: root, ...v };
        }
      }
      return { name: "Macintosh HD", external: false, ejectable: false, solidState: true, writable: true, caseSensitive: false, xattrs: true, granularityMs: 0, restrictNames: false, maxFileSize: null, fsType: "apfs", fsLabel: "APFS", mountPoint: "/" };
    },
  };
}

async function withDrives(byRoot, fn) {
  const saved = ctx.volumes;
  const savedAwake = ctx.keepAwake;
  ctx.volumes = fakeVolumes(byRoot);
  const awake = { started: 0, released: 0 };
  ctx.keepAwake = () => {
    awake.started++;
    return () => awake.released++;
  };
  try {
    return await fn(awake);
  } finally {
    ctx.volumes = saved;
    ctx.keepAwake = savedAwake;
  }
}

function makeRef() {
  const ref = makeTree(tmpDir("dref"), { "Album/a.jpg": "jpeg", "Album/b.txt": "bee", "notes.txt": "notes" });
  for (const rel of ["Album/a.jpg", "Album/b.txt", "notes.txt", "Album", ""]) setMtime(path.join(ref, rel), T1);
  return ref;
}

test("exFAT SSD at the top of the drive: system folders are left alone, no ._ files, the Mac stays awake", async () => {
  const ref = makeRef();
  const drive = makeTree(tmpDir("T7"), { ".Spotlight-V100/store": "x", ".fseventsd/log": "x", ".Trashes/": null, "stray.tmp": "old" });
  await withDrives({ [drive]: { fsType: "exfat", fsLabel: "ExFAT", xattrs: false, granularityMs: 10, restrictNames: true, model: "Samsung PSSD T7" } }, async (awake) => {
    const plan = await call("sync.analyze", { reference: ref, targets: [drive], options: { mirror: true, includeAll: true } });
    const t = plan.targets[0];
    assert.equal(t.volume.isVolumeRoot, true);
    assert.equal(t.volume.fsLabel, "ExFAT");
    assert.equal(t.volume.model, "Samsung PSSD T7");
    assert.match(t.info, /“\._” files/);
    const removes = t.actions.filter((a) => a.op === "remove").map((a) => a.rel);
    assert.deepEqual(removes, ["stray.tmp"], "only the stray file goes; .Spotlight-V100, .fseventsd and .Trashes stay");
    assert.ok(!t.actions.some((a) => a.rel === ""), "the drive's top folder keeps its own dates");

    const res = await call("sync.run", { planId: plan.id });
    assert.equal(res.targets[0].errors.length, 0, JSON.stringify(res.targets[0].errors));
    assert.equal(res.targets[0].verify.mismatches, 0);
    assert.ok(fs.existsSync(path.join(drive, ".Spotlight-V100", "store")));
    assert.ok(fs.existsSync(path.join(drive, ".fseventsd", "log")));
    assert.ok(!fs.existsSync(path.join(drive, "stray.tmp")));
    assert.equal(fs.readFileSync(path.join(drive, "notes.txt"), "utf8"), "notes");
    assert.ok(Math.abs(fs.statSync(path.join(drive, "Album", "b.txt")).mtimeMs - T1) < 2);
    assert.deepEqual(awake, { started: 1, released: 1 });
  });
});

test("FAT32: files over the size limit are flagged and skipped, the rest is copied; 2-second dates count as equal", async () => {
  const ref = makeRef();
  fs.writeFileSync(path.join(ref, "big.bin"), "x".repeat(5000));
  setMtime(path.join(ref, "big.bin"), T1);
  const drive = makeTree(tmpDir("FAT"), { "notes.txt": "notes" });
  setMtime(path.join(drive, "notes.txt"), T1 + 1500); // FAT stores times in 2-second steps
  await withDrives({ [drive]: { fsType: "msdos", fsLabel: "FAT32", xattrs: false, granularityMs: 2000, restrictNames: true, maxFileSize: 1000 } }, async () => {
    const plan = await call("sync.analyze", { reference: ref, targets: [drive] });
    const t = plan.targets[0];
    const big = t.actions.find((a) => a.rel === "big.bin");
    assert.match(big.blocked, /can't store/);
    assert.ok(t.warnings.some((w) => /over 4 GB/.test(w)));
    assert.equal(t.stats.blocked, 1);
    assert.ok(!t.actions.some((a) => a.rel === "notes.txt"), "1.5 s apart is the same time on FAT");
    const res = await call("sync.run", { planId: plan.id });
    assert.ok(!fs.existsSync(path.join(drive, "big.bin")));
    assert.ok(fs.existsSync(path.join(drive, "Album", "a.jpg")));
    assert.equal(res.targets[0].skipped, 1);
  });
});

test("names exFAT can't store are pointed out before copying", async () => {
  const ref = makeRef();
  fs.writeFileSync(path.join(ref, "what?.txt"), "q");
  const drive = tmpDir("T9");
  await withDrives({ [drive]: { fsType: "exfat", fsLabel: "ExFAT", xattrs: false, granularityMs: 10, restrictNames: true } }, async () => {
    const plan = await call("sync.analyze", { reference: ref, targets: [drive] });
    assert.ok(plan.targets[0].warnings.some((w) => w.includes("what?.txt")));
  });
});

test("an NTFS drive (read-only on macOS) is refused with an explanation", async () => {
  const ref = makeRef();
  const drive = tmpDir("NTFS");
  await withDrives({ [drive]: { fsType: "ntfs", fsLabel: "NTFS", writable: false } }, async () => {
    const plan = await call("sync.analyze", { reference: ref, targets: [drive] });
    assert.match(plan.targets[0].blockedReason, /NTFS/);
    assert.equal(plan.allEnough, false);
  });
});

test("leftovers from an interrupted sync are cleaned up, and an unplugged drive stops the sync clearly", async () => {
  const ref = makeRef();
  const drive = makeTree(tmpDir("T7b"), { "Album/.myfile-partial-abc123-a.jpg": "half" });
  const gone = tmpDir("T7c");
  await withDrives({ [drive]: {}, [gone]: {} }, async () => {
    const plan = await call("sync.analyze", { reference: ref, targets: [drive] });
    assert.match(plan.targets[0].info, /unfinished cop/);
    await call("sync.run", { planId: plan.id });
    assert.ok(!fs.existsSync(path.join(drive, "Album", ".myfile-partial-abc123-a.jpg")));

    // Unplugged between analysis and copying.
    const plan2 = await call("sync.analyze", { reference: ref, targets: [gone] });
    fs.rmSync(gone, { recursive: true, force: true });
    await assert.rejects(call("sync.run", { planId: plan2.id }), /was disconnected/);
  });
});

test("delete mode frees space instead of filling the drive's Trash", async () => {
  const ref = makeRef();
  const drive = makeTree(tmpDir("T7d"), { "notes.txt": "older notes!", "extra.txt": "x" });
  await withDrives({ [drive]: {} }, async () => {
    const before = trashed.length;
    const plan = await call("sync.analyze", { reference: ref, targets: [drive], options: { mirror: true, removeMode: "delete" } });
    await call("sync.run", { planId: plan.id });
    assert.equal(trashed.length, before, "nothing went to the Trash");
    assert.ok(!fs.existsSync(path.join(drive, "extra.txt")));
    assert.equal(fs.readFileSync(path.join(drive, "notes.txt"), "utf8"), "notes");
  });
});

test("diskutil's property lists are read correctly", () => {
  const xml = '<?xml version="1.0"?><plist version="1.0"><dict><key>VolumeName</key><string>T7 &amp; Photos</string><key>Internal</key><false/><key>FilesystemType</key><string>exfat</string><key>TotalSize</key><integer>1000202273280</integer><key>APFSPhysicalStores</key><array><dict><key>APFSPhysicalStore</key><string>disk4s2</string></dict></array></dict></plist>';
  const d = realVolumes.parsePlist(xml);
  assert.equal(d.VolumeName, "T7 & Photos");
  assert.equal(d.Internal, false);
  assert.equal(d.TotalSize, 1000202273280);
  assert.equal(d.APFSPhysicalStores[0].APFSPhysicalStore, "disk4s2");
  assert.equal(realVolumes.nameProblem("IMG_0001.HEIC"), null);
  assert.match(realVolumes.nameProblem("a:b"), /“:”/);
  assert.ok(realVolumes.isVolumeSystemItem(".Spotlight-V100"));
});

test("df output names the volume holding a folder, including names with spaces", () => {
  const data = "Filesystem     1024-blocks      Used Available Capacity  Mounted on\n/dev/disk3s5s1   976490576 150000000 800000000    16%    /System/Volumes/Data\n";
  assert.equal(realVolumes.parseDfMountPoint(data), "/System/Volumes/Data");
  const t7 = "Filesystem   1024-blocks Used Available Capacity Mounted on\n/dev/disk5s2  976490576 1000 976000000    1%    /Volumes/Samsung T7 Shield\n";
  assert.equal(realVolumes.parseDfMountPoint(t7), "/Volumes/Samsung T7 Shield");
  assert.equal(realVolumes.parseDfMountPoint(""), null);
});

test("a folder you can write to is writable; one you can't says so without blaming the disk", async (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip("root can write anywhere");
  const open = tmpDir("perm-open");
  const locked = tmpDir("perm-locked");
  fs.chmodSync(locked, 0o555);
  try {
    const a = await realVolumes.info(open);
    assert.equal(a.writable, true);
    const b = await realVolumes.info(path.join(locked, "not-yet"));
    assert.equal(b.pathWritable, false);
    assert.equal(b.writable, false);
    assert.equal(b.volumeWritable, a.volumeWritable);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
});

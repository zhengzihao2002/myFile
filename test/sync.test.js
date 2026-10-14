"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTree, tmpDir, testContext, setMtime } = require("./helpers");

const { et, call, trashed } = testContext();
test.after(() => et.close());

const T1 = Date.UTC(2019, 1, 2, 3, 4, 5, 250);

function listTree(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (fs.statSync(full).isDirectory()) {
        out.push(`${r}/`);
        walk(full, r);
      } else out.push(`${r}=${fs.readFileSync(full, "utf8")}`);
    }
  };
  walk(root, "");
  return out;
}

function makeRef() {
  const ref = makeTree(tmpDir("syncRef"), {
    "Albums/2019/a.txt": "aaaa",
    "Albums/2019/b.txt": "bbbbbbbb",
    "Docs/readme.md": "read me",
    "Videos/clip.bin": "0123456789".repeat(50),
    "loose.txt": "loose",
  });
  for (const rel of ["Albums/2019/a.txt", "Albums/2019/b.txt", "Docs/readme.md", "Videos/clip.bin", "loose.txt", "Albums/2019", "Albums", "Docs", "Videos", ""]) {
    setMtime(path.join(ref, rel), T1);
  }
  return ref;
}

test("direct clone into an empty folder, then mirror changes", async () => {
  const ref = makeRef();
  const target = tmpDir("syncT");
  const plan = await call("sync.analyze", { reference: ref, targets: [target], mode: "direct" });
  const t = plan.targets[0];
  assert.equal(t.stats.copy, 5);
  assert.equal(t.stats.mkdir, 4);
  assert.equal(t.enough, true);

  const res = await call("sync.run", { planId: plan.id });
  assert.equal(res.targets[0].errors.length, 0, JSON.stringify(res.targets[0].errors));
  assert.deepEqual(listTree(target), listTree(ref));
  assert.equal(res.targets[0].verify.mismatches, 0, res.targets[0].verify.sample.join("\n"));
  assert.ok(Math.abs(fs.statSync(path.join(target, "Albums", "2019", "a.txt")).mtimeMs - T1) < 2);
  assert.ok(Math.abs(fs.statSync(path.join(target, "Albums")).mtimeMs - T1) < 2, "folder dates set after copying");
  assert.ok(res.bytesWritten > 500);

  // Change the reference: edit one file, add one, delete one; add junk to the target.
  fs.writeFileSync(path.join(ref, "Docs", "readme.md"), "read me now");
  fs.writeFileSync(path.join(ref, "Docs", "new.md"), "new");
  fs.rmSync(path.join(ref, "loose.txt"));
  fs.writeFileSync(path.join(target, "Docs", "stray.tmp"), "stray");
  setMtime(path.join(target, "Videos", "clip.bin"), T1 + 86400000);

  const plan2 = await call("sync.analyze", { reference: ref, targets: [target], options: { mirror: true } });
  const ops = Object.fromEntries(plan2.targets[0].actions.map((a) => [a.rel, a.op]));
  assert.equal(ops["Docs/readme.md"], "replace");
  assert.equal(ops["Docs/new.md"], "copy");
  assert.equal(ops["loose.txt"], "remove");
  assert.equal(ops["Docs/stray.tmp"], "remove");
  assert.equal(ops["Videos/clip.bin"], "touch", "same bytes, different date: dates only");

  const before = trashed.length;
  await call("sync.run", { planId: plan2.id });
  assert.deepEqual(listTree(target), listTree(ref));
  assert.ok(trashed.length - before >= 3, "replaced and removed items went to the Trash");
  assert.ok(Math.abs(fs.statSync(path.join(target, "Videos", "clip.bin")).mtimeMs - T1) < 2);

  const plan3 = await call("sync.analyze", { reference: ref, targets: [target], options: { mirror: true } });
  const pending = plan3.targets[0].actions.filter((a) => a.op !== "touch" || a.kind !== "dir");
  assert.deepEqual(pending.map((a) => `${a.op} ${a.rel}`), [], "nothing left to do");
});

test("split clone shares top-level items across targets and keeps them where they are", async () => {
  const ref = makeRef();
  const t1 = tmpDir("split1");
  const t2 = tmpDir("split2");
  // Docs already lives on the second target.
  makeTree(t2, { "Docs/readme.md": "read me" });

  const plan = await call("sync.analyze", { reference: ref, targets: [t1, t2], mode: "split" });
  const where = Object.fromEntries(plan.units.map((u) => [u.rel, u.targets]));
  assert.deepEqual(where.Docs, [1], "existing items stay on their target");
  for (const u of plan.units) assert.equal(u.targets.length, 1, "each item goes to exactly one target");

  await call("sync.run", { planId: plan.id });
  const all = [...listTree(t1), ...listTree(t2)].filter((x) => !x.endsWith("/")).sort();
  const want = listTree(ref).filter((x) => !x.endsWith("/")).sort();
  assert.deepEqual(all, want, "together the targets hold one copy of everything");

  // A manual choice moves an item; with mirror on, the old copy goes to the Trash.
  const docsOn = where.Docs[0];
  const other = docsOn === 0 ? 1 : 0;
  const moved = await call("sync.analyze", { reference: ref, targets: [t1, t2], mode: "split", options: { assignments: { Docs: other }, mirror: true } });
  const ops = moved.targets[docsOn].actions.filter((a) => a.rel === "Docs");
  assert.equal(ops[0].op, "remove");
  assert.equal(ops[0].reason, "elsewhere");
});

test("partial clone copies only what was picked", async () => {
  const ref = makeRef();
  const target = tmpDir("partial");
  makeTree(target, { "Docs/keep-me.txt": "mine" });
  const plan = await call("sync.analyze", { reference: ref, targets: [target], selection: ["Albums/2019/a.txt", "Docs"], options: { mirror: true } });
  const rels = plan.targets[0].actions.map((a) => `${a.op} ${a.rel}`).sort();
  assert.ok(rels.includes("copy Albums/2019/a.txt"));
  assert.ok(!rels.some((r) => r.includes("b.txt")));
  assert.ok(!rels.some((r) => r.includes("Videos")));
  assert.ok(rels.includes("remove Docs/keep-me.txt"), "mirror applies inside picked folders");
  await call("sync.run", { planId: plan.id });
  assert.ok(fs.existsSync(path.join(target, "Albums", "2019", "a.txt")));
  assert.ok(!fs.existsSync(path.join(target, "Albums", "2019", "b.txt")));
  assert.ok(!fs.existsSync(path.join(target, "Videos")));
});

test("a single file can be the reference", async () => {
  const ref = makeRef();
  const target = tmpDir("single");
  const plan = await call("sync.analyze", { reference: path.join(ref, "loose.txt"), targets: [target] });
  assert.equal(plan.reference.singleFile, true);
  assert.deepEqual(plan.targets[0].actions.map((a) => `${a.op} ${a.rel}`), ["copy loose.txt"]);
  await call("sync.run", { planId: plan.id });
  assert.equal(fs.readFileSync(path.join(target, "loose.txt"), "utf8"), "loose");
});

test("refuses overlapping folders", async () => {
  const ref = makeRef();
  await assert.rejects(call("sync.analyze", { reference: ref, targets: [path.join(ref, "Docs")] }), /inside the reference/);
  await assert.rejects(call("sync.analyze", { reference: ref, targets: [ref] }), /reference itself/);
  const t = tmpDir("one");
  await assert.rejects(call("sync.analyze", { reference: ref, targets: [t], mode: "split" }), /at least two/);
});

test("reference tree lists children with sizes for the picker", async () => {
  const ref = makeRef();
  const tree = await call("sync.tree", { reference: ref });
  assert.deepEqual(tree.children.map((c) => c.name), ["Albums", "Docs", "Videos", "loose.txt"]);
  assert.equal(tree.children[0].size, 12);
  const kids = await call("sync.children", { reference: ref, rel: "Albums" });
  assert.deepEqual(kids.map((k) => k.rel), ["Albums/2019"]);
});

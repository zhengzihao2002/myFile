"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { tmpDir } = require("./helpers");
const { updateSource } = require("../src/main/features/updater");
const run = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
const commit = (cwd, message) => { run(cwd, "add", "."); run(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", message); };
function setup() {
  const root = tmpDir("update-source");
  const origin = path.join(root, "origin.git");
  run(root, "init", "--bare", "-b", "main", origin);
  const author = path.join(root, "author");
  run(root, "clone", origin, author);
  fs.writeFileSync(path.join(author, ".gitignore"), ".runtime/\n");
  fs.writeFileSync(path.join(author, "source.txt"), "base");
  commit(author, "base");
  run(author, "push", "origin", "main");
  const mine = path.join(root, "mine");
  run(root, "clone", "-b", "main", origin, mine);
  fs.mkdirSync(path.join(mine, ".runtime"));
  fs.writeFileSync(path.join(mine, ".runtime", "settings.json"), "keep settings");
  return { author, mine, ctx: { runtime: { projectRoot: mine } }, task: { progress() {} } };
}
test("updater fast-forwards normally and leaves settings and untracked files alone", async () => {
  const { author, mine, ctx, task } = setup();
  fs.writeFileSync(path.join(mine, "notes.txt"), "keep notes");
  fs.writeFileSync(path.join(author, "source.txt"), "new"); commit(author, "update"); run(author, "push", "origin", "main");
  assert.equal((await updateSource(ctx, task)).backup, null);
  assert.equal(run(mine, "rev-parse", "HEAD"), run(author, "rev-parse", "HEAD"));
  assert.equal(fs.readFileSync(path.join(mine, ".runtime", "settings.json"), "utf8"), "keep settings");
  assert.equal(fs.readFileSync(path.join(mine, "notes.txt"), "utf8"), "keep notes");
});
test("updater recovers from rewritten main, preserving the previous checkout on a backup branch", async () => {
  const { author, mine, ctx, task } = setup();
  const base = run(author, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(author, "source.txt"), "old published fix"); commit(author, "old fix"); run(author, "push", "origin", "main");
  run(mine, "pull", "--ff-only"); const previous = run(mine, "rev-parse", "HEAD");
  run(author, "reset", "--hard", base);
  fs.writeFileSync(path.join(author, "source.txt"), "consolidated fix"); commit(author, "new fix"); run(author, "push", "--force", "origin", "main");
  const { backup } = await updateSource(ctx, task);
  assert.match(backup, /^myfile-before-update-/);
  assert.equal(run(mine, "rev-parse", backup), previous);
  assert.equal(run(mine, "rev-parse", "HEAD"), run(author, "rev-parse", "HEAD"));
  assert.equal(fs.readFileSync(path.join(mine, "source.txt"), "utf8"), "consolidated fix");
  assert.equal(fs.readFileSync(path.join(mine, ".runtime", "settings.json"), "utf8"), "keep settings");
});
test("updater preserves local commits when adopting official main", async () => {
  const { author, mine, ctx, task } = setup();
  fs.writeFileSync(path.join(mine, "local.txt"), "local customization"); commit(mine, "local work");
  const previous = run(mine, "rev-parse", "HEAD");
  const { backup } = await updateSource(ctx, task);
  assert.equal(run(mine, "rev-parse", "HEAD"), run(author, "rev-parse", "HEAD"));
  assert.equal(run(mine, "show", `${backup}:local.txt`), "local customization");
  assert.equal(run(mine, "rev-parse", backup), previous);
});
test("updater refuses uncommitted edits and leaves the checkout untouched", async () => {
  const { mine, ctx, task } = setup();
  const previous = run(mine, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(mine, "source.txt"), "unsaved work");
  await assert.rejects(updateSource(ctx, task), /Commit or stash/);
  assert.equal(run(mine, "rev-parse", "HEAD"), previous);
  assert.equal(fs.readFileSync(path.join(mine, "source.txt"), "utf8"), "unsaved work");
});
test("updater refuses to overwrite an untracked file in the update's path", async () => {
  const { author, mine, ctx, task } = setup();
  const previous = run(mine, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(author, "new.txt"), "published"); commit(author, "new file"); run(author, "push", "origin", "main");
  fs.writeFileSync(path.join(mine, "new.txt"), "personal file");
  await assert.rejects(updateSource(ctx, task), /couldn't be downloaded/);
  assert.equal(run(mine, "rev-parse", "HEAD"), previous);
  assert.equal(fs.readFileSync(path.join(mine, "new.txt"), "utf8"), "personal file");
});

test("divergence recovery also refuses conflicting untracked files", async () => {
  const { author, mine, ctx, task } = setup();
  fs.writeFileSync(path.join(mine, "local.txt"), "local commit"); commit(mine, "local work");
  const previous = run(mine, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(author, "new.txt"), "published"); commit(author, "new file"); run(author, "push", "origin", "main");
  fs.writeFileSync(path.join(mine, "new.txt"), "personal file");
  await assert.rejects(updateSource(ctx, task), /couldn't be downloaded/);
  assert.equal(run(mine, "rev-parse", "HEAD"), previous);
  assert.equal(fs.readFileSync(path.join(mine, "new.txt"), "utf8"), "personal file");
  assert.equal(fs.readFileSync(path.join(mine, "local.txt"), "utf8"), "local commit");
});

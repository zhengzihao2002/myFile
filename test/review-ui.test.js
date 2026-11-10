"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createServer } = require("./harness/server");
const { tmpDir, makeJpeg, makeMovie, setMtime } = require("./helpers");
const session = require("../src/main/features/review-session");

function browserTools() {
  let chromium;
  for (const name of ["playwright", "playwright-core", "/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core"]) {
    try { chromium = require(name).chromium; break; }
    catch (err) { if (err.code !== "MODULE_NOT_FOUND") throw err; }
  }
  if (!chromium) return { reason: "Playwright is not installed; browser checks are optional." };
  const executablePath = [process.env.MYFILE_TEST_CHROMIUM, chromium.executablePath(), "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find((p) => p && fs.existsSync(p));
  return executablePath ? { chromium, executablePath } : { reason: "Chromium is not installed; browser checks are optional." };
}
async function dropPaths(page, paths) {
  await page.locator(".view .drop").first().evaluate((el, paths) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", paths.join("\n"));
    el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
  }, paths);
}
async function currentFile(page, name) {
  await page.locator(".stage .fname").filter({ hasText: name }).waitFor({ state: "visible" });
  await page.getByText("What should win?", { exact: true }).waitFor({ state: "visible" });
}
async function savedAfter(page, action, predicate = () => true) {
  const saved = page.waitForResponse((res) => {
    if (!res.url().endsWith("/task")) return false;
    const req = res.request().postDataJSON();
    return req.name === "exif.reviewSave" && predicate(req.payload.state);
  });
  await action();
  const response = await saved;
  assert.equal((await response.json()).ok, true);
}

test("date review filters, warnings, saved sessions and validation remain usable", { timeout: 120000 }, async (t) => {
  const available = browserTools();
  if (available.reason) return t.skip(available.reason);
  const harness = createServer({ dataDir: tmpDir("review-ui-data") });
  await new Promise((resolve) => harness.server.listen(0, "127.0.0.1", resolve));
  t.after(() => harness.close());
  const browser = await available.chromium.launch({ executablePath: available.executablePath, headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const errors = [];

  async function pageFor(t, { resume = false } = {}) {
    if (!resume) session.clear(harness.ctx);
    const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", (err) => errors.push(err.message));
    t.after(() => context.close());
    await page.goto(`http://127.0.0.1:${harness.server.address().port}`);
    await page.locator(".header h1").filter({ hasText: /\S/ }).waitFor();
    await page.evaluate(() => MF.go("exif-modify", { mode: "self" }));
    await page.locator(".view .drop").first().waitFor();
    return page;
  }
  async function photo(root, name, { date = "2023:05:01 12:00:00", offset = "+08:00", modified = "2024-01-01T00:00:00Z" } = {}) {
    const file = makeJpeg(path.join(root, name));
    const tags = [];
    if (date) tags.push(["DateTimeOriginal", date]);
    if (offset) tags.push(["OffsetTimeOriginal", offset]);
    if (tags.length) await harness.ctx.et.write(file, tags);
    setMtime(file, Date.parse(modified));
    return file;
  }

  await t.test("search and type/date/failure filters limit the actual review queue", async (t) => {
    const root = tmpDir("review-filter");
    const zoned = await photo(root, "a-zoned.jpg");
    await photo(root, "b-unknown.jpg", { offset: null });
    await photo(root, "c-undated.jpg", { date: null, offset: null });
    const matching = await photo(root, "d-matching.jpg", { modified: "2023-05-01T04:00:00Z" });
    // On macOS the birth time also participates. Make matching's EXIF and
    // modified values match its actual birth time within the date tolerance.
    if (process.platform === "darwin") {
      const ms = fs.statSync(matching).birthtimeMs;
      const wall = new Date(ms + 8 * 3600000).toISOString().slice(0, 19).replace(/-/g, ":").replace("T", " ");
      await harness.ctx.et.write(matching, [["DateTimeOriginal", wall]]);
      setMtime(matching, ms);
    }
    const movie = makeMovie(path.join(root, "e-video.mov"));
    await harness.ctx.et.write(movie, [["QuickTime:CreateDate", "2022:02:03 04:05:06Z"]]);
    setMtime(movie, Date.parse("2024-01-01T00:00:00Z"));
    const page = await pageFor(t);
    await dropPaths(page, [root]);
    await currentFile(page, "a-zoned.jpg");
    const filter = page.getByLabel("Filter review files");
    const search = page.getByLabel("Search review files");
    assert.equal(await page.locator(".bt-name").count(), 5);
    await filter.selectOption("videos");
    await currentFile(page, "e-video.mov");
    assert.deepEqual(await page.locator(".bt-name").allTextContents(), ["e-video.mov"]);
    await filter.selectOption("photos");
    await currentFile(page, "a-zoned.jpg");
    assert.equal(await page.locator(".bt-name").count(), 4);
    await search.fill("b-unknown");
    await currentFile(page, "b-unknown.jpg");
    assert.deepEqual(await page.locator(".bt-name").allTextContents(), ["b-unknown.jpg"]);
    await search.fill("");
    await filter.selectOption("unknown");
    await currentFile(page, "b-unknown.jpg");
    assert.deepEqual(await page.locator(".bt-name").allTextContents(), ["b-unknown.jpg"]);
    await filter.selectOption("no-date");
    await currentFile(page, "c-undated.jpg");
    assert.deepEqual(await page.locator(".bt-name").allTextContents(), ["c-undated.jpg"]);
    await filter.selectOption("matching");
    await page.locator(".bt-name").filter({ hasText: "d-matching.jpg" }).waitFor();
    assert.ok(!(await page.locator(".bt-name").allTextContents()).includes("a-zoned.jpg"));
    await filter.selectOption("all");
    await page.locator(".bt-item").filter({ hasText: "a-zoned.jpg" }).click();
    await currentFile(page, "a-zoned.jpg");
    await page.route("**/task", async (route) => {
      const req = route.request().postDataJSON();
      if (req.name === "exif.batchApply") await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, result: { results: [{ path: zoned, ok: false, error: "Simulated read-only drive" }], ok: 0, failed: 1 } }) });
      else await route.continue();
    });
    await page.getByRole("button", { name: "Save & next", exact: true }).click();
    await page.locator(".bt-item").filter({ hasText: "Save failed" }).waitFor();
    await filter.selectOption("failed");
    await currentFile(page, "a-zoned.jpg");
    assert.deepEqual(await page.locator(".bt-name").allTextContents(), ["a-zoned.jpg"]);
    assert.match(await page.locator(".bt-sub").textContent(), /read-only drive/);
  });

  await t.test("saving an unzoned file updates the review summary immediately", async (t) => {
    const root = tmpDir("review-live-counts");
    const unknown = await photo(root, "a-unknown.jpg", { offset: null });
    await photo(root, "b-zoned.jpg");
    const page = await pageFor(t);
    await dropPaths(page, [root]);
    await currentFile(page, "a-unknown.jpg");
    assert.match(await page.locator(".bt-counts").textContent(), /1 need a time zone/);
    await page.getByRole("button", { name: "Beijing", exact: true }).click();
    await page.getByRole("button", { name: "Save & next", exact: true }).waitFor();
    await page.getByRole("button", { name: "Save & next", exact: true }).click();
    await currentFile(page, "b-zoned.jpg");
    const text = await page.locator(".bt-counts").textContent();
    assert.match(text, /1 already agree/);
    assert.doesNotMatch(text, /need a time zone/);
    assert.equal(fs.statSync(unknown).mtimeMs, Date.parse("2023-05-01T04:00:00Z"));
  });

  await t.test("unreadable subfolders have a visible warning with path and reason", async (t) => {
    if (process.platform === "win32" || process.getuid && process.getuid() === 0) return t.skip("Permission-denied fixture requires a non-root POSIX account.");
    const root = tmpDir("review-warning");
    await photo(root, "visible.jpg");
    const locked = path.join(root, "unreadable");
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0);
    t.after(() => fs.chmodSync(locked, 0o700));
    const page = await pageFor(t);
    await dropPaths(page, [root]);
    await currentFile(page, "visible.jpg");
    await page.locator(".bt-warnings").waitFor({ state: "visible" });
    await page.locator(".bt-warnings summary").click();
    assert.match(await page.locator(".bt-warnings").textContent(), /unreadable/);
    assert.match(await page.locator(".bt-warnings").textContent(), /permission|EACCES/i);
  });

  await t.test("a fresh browser resumes choices, skipped files, current file and filters; Clear forgets the draft", async (t) => {
    const root = tmpDir("review-restart");
    await photo(root, "a.jpg");
    const b = await photo(root, "b.jpg");
    const page = await pageFor(t);
    await dropPaths(page, [root]);
    await currentFile(page, "a.jpg");
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    await currentFile(page, "b.jpg");
    await page.getByRole("button", { name: /Everything follows Modified/ }).click();
    await page.locator(".bt-choice.on").filter({ hasText: "Everything follows Modified" }).waitFor();
    await page.getByLabel("Filter review files").selectOption("photos");
    await savedAfter(page, () => page.getByLabel("Search review files").fill("b.jpg"), (state) => state.current === b && state.filter === "photos" && state.search === "b.jpg");
    await page.context().close();
    // Change the disk value between sessions to ensure resume rereads it.
    setMtime(b, Date.parse("2025-04-05T06:07:08Z"));
    const resumed = await pageFor(t, { resume: true });
    await currentFile(resumed, "b.jpg");
    assert.equal(await resumed.getByLabel("Search review files").inputValue(), "b.jpg");
    assert.equal(await resumed.getByLabel("Filter review files").inputValue(), "photos");
    assert.match(await resumed.locator(".bt-choice.on").textContent(), /Everything follows Modified/);
    assert.match(await resumed.locator(".bt-field").filter({ hasText: "Modified" }).textContent(), /2025-04-05/);
    assert.equal(await resumed.locator(".drop .item .name").textContent(), path.basename(root));
    await resumed.getByLabel("Search review files").fill("");
    await resumed.getByRole("tab", { name: /^Skipped/ }).click();
    await currentFile(resumed, "a.jpg");
    await resumed.getByRole("tab", { name: /^To do/ }).click();
    await currentFile(resumed, "b.jpg");
    const cleared = resumed.waitForResponse((res) => res.url().endsWith("/task") && res.request().postDataJSON().name === "exif.reviewClear");
    await resumed.getByRole("button", { name: "Clear", exact: true }).click();
    assert.equal((await (await cleared).json()).ok, true);
    await dropPaths(resumed, [root]);
    await currentFile(resumed, "a.jpg");
    assert.equal(await resumed.getByLabel("Filter review files").inputValue(), "photos", "Clear leaves selected queue filters alone");
    // Clear once more after proving the filters survived, then restart.
    const clearedAgain = resumed.waitForResponse((res) => res.url().endsWith("/task") && res.request().postDataJSON().name === "exif.reviewClear");
    await resumed.getByRole("button", { name: "Clear", exact: true }).click();
    await clearedAgain;
    await resumed.context().close();
    const empty = await pageFor(t, { resume: true });
    assert.equal(await empty.locator(".drop .item").count(), 0);
    assert.equal(await empty.locator(".bt-embed").isVisible(), false);
  });

  await t.test("an unavailable saved selection cannot transfer its draft into the next unrelated drop", async (t) => {
    const oldRoot = tmpDir("review-missing-draft");
    const missing = await photo(oldRoot, "missing.jpg");
    const newRoot = tmpDir("review-unrelated-drop");
    const fresh = await photo(newRoot, "fresh.jpg");
    const history = harness.ctx.history.add({ type: "exif-batch", title: "Old missing review", undo: { times: [{ path: missing, mtimeMs: 1000 }] } });
    const scan = { paths: [missing], raws: new Map([[missing, { wall: "2023:05:01 12:00:00", storedOffsetMin: 480, createdMs: 1000, modifiedMs: 1000 }]]), folders: new Map(), savedPaths: new Map([[missing, "saved"]]), historyId: history.id };
    harness.ctx.remember("missing-draft", scan);
    session.save(harness.ctx, { scanId: "missing-draft", state: { decisions: [[missing, { choice: "all-modified", tz: "Asia/Shanghai", writeTz: true }]], status: [[missing, "saved"]], current: missing, tab: "saved", filter: "videos", search: "missing", useGps: false } });
    fs.unlinkSync(missing);
    const page = await pageFor(t, { resume: true });
    await page.locator(".toast .td").filter({ hasText: /missing\.jpg.*can't be found/ }).waitFor();
    assert.equal(await page.locator(".drop .item").count(), 0);
    await savedAfter(page, () => dropPaths(page, [fresh]), (state) => state.current === fresh);
    await currentFile(page, "fresh.jpg");
    assert.match(await page.locator(".bt-choice.on").textContent(), /Everything follows the EXIF date/);
    const replacement = session.load(harness.ctx);
    assert.deepEqual(replacement.paths, [fresh]);
    assert.equal(replacement.historyId, null, "the old Undo session is not attached to an unrelated file");
    assert.equal(replacement.state.tab, "todo");
    assert.equal(replacement.state.filter, "all");
    assert.equal(replacement.state.search, "");
    assert.equal(replacement.state.useGps, true);
    assert.deepEqual(replacement.state.status, []);
    assert.deepEqual(replacement.state.decisions.map(([file]) => file), [fresh]);
    assert.equal(fs.statSync(fresh).mtimeMs, Date.parse("2024-01-01T00:00:00Z"));
  });

  await t.test("invalid time-zone input keeps the picker available for correction", async (t) => {
    const root = tmpDir("review-invalid-zone");
    const a = await photo(root, "a.jpg");
    await photo(root, "b.jpg");
    const page = await pageFor(t);
    await dropPaths(page, [root]);
    await currentFile(page, "a.jpg");
    await page.locator(".bt-zonepick select").selectOption("other");
    const offset = page.locator(".bt-zonepick input");
    await offset.fill("+08:99");
    await page.locator(".bt-sidefoot .callout.red").waitFor();
    assert.equal(await offset.isVisible(), true);
    assert.equal(await offset.inputValue(), "+08:99");
    assert.equal(await page.getByRole("button", { name: "Save & next", exact: true }).count(), 0);
    await offset.fill("+09:00");
    await page.getByRole("button", { name: "Save & next", exact: true }).waitFor();
    assert.equal(await page.locator(".bt-sidefoot .callout.red").count(), 0);
    assert.equal(fs.statSync(a).mtimeMs, Date.parse("2024-01-01T00:00:00Z"), "validation edits do not write a file");
  });

  await t.test("bulk actions explain their effect on unsaved per-file choices before any write", async (t) => {
    const root = tmpDir("review-bulk");
    const a = await photo(root, "a.jpg");
    await photo(root, "b.jpg");
    const page = await pageFor(t);
    await dropPaths(page, [root]);
    await currentFile(page, "a.jpg");
    await page.getByRole("button", { name: /Everything follows Modified/ }).click();
    await page.locator(".bt-choice.on").filter({ hasText: "Everything follows Modified" }).waitFor();
    assert.match(await page.locator(".bt-bulk").textContent(), /overrides.*unsaved date and time-zone choices/i);
    await page.getByRole("button", { name: /Apply to all .*remaining/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    assert.match(await dialog.textContent(), /overrides unsaved per-file date and time-zone choices/);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(fs.statSync(a).mtimeMs, Date.parse("2024-01-01T00:00:00Z"));
  });
  assert.deepEqual(errors, [], "no unhandled renderer errors");
});

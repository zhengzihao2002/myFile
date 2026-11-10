"use strict";

// Exercise the real renderer and backend together. These checks are optional on
// machines without a browser; no browser package is needed to run the other tests.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createServer } = require("./harness/server");
const { makeJpeg, makeMovie, tmpDir, setMtime, readTags } = require("./helpers");

function browserTools() {
  let chromium;
  for (const name of ["playwright", "playwright-core", "/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core"]) {
    try {
      chromium = require(name).chromium;
      break;
    } catch (err) {
      if (err.code !== "MODULE_NOT_FOUND") throw err;
    }
  }
  if (!chromium) return { reason: "Playwright is not installed; browser regression checks are optional." };
  const executablePath = [process.env.MYFILE_TEST_CHROMIUM, chromium.executablePath(), "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find((p) => p && fs.existsSync(p));
  if (!executablePath) return { reason: "Chromium is not installed; browser regression checks are optional." };
  return { chromium, executablePath };
}

async function dropPaths(page, paths) {
  // Electron supplies native paths for dropped File objects. In a browser the
  // component's text/plain fallback accepts the same native paths.
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

async function detailedEditor(page) {
  await page.locator(".kvh").filter({ hasText: /^Time zone/ }).waitFor({ state: "visible" });
  for (const text of ["What should win?", "What will change", "Change just one"]) {
    await page.getByText(text, { exact: true }).waitFor({ state: "visible" });
  }
  assert.equal(await page.locator(".bt-field").count() >= 2, true);
}

test("Modify reviews loose files and folders with the detailed per-file editor", { timeout: 120000 }, async (t) => {
  const available = browserTools();
  if (available.reason) return t.skip(available.reason);
  const harness = createServer({ dataDir: tmpDir("modify-ui-data") });
  await new Promise((resolve) => harness.server.listen(0, "127.0.0.1", resolve));
  t.after(() => harness.close());
  const browser = await available.chromium.launch({ executablePath: available.executablePath, headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const url = `http://127.0.0.1:${harness.server.address().port}`;
  const errors = [];

  async function pageFor(t) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    page.setDefaultTimeout(10000);
    page.on("pageerror", (err) => errors.push(err.message));
    t.after(() => page.close());
    await page.goto(url);
    // The shell exists while its initial settings request is still pending.
    // Wait for initial navigation before choosing the screen under test.
    await page.locator(".header h1").filter({ hasText: /\S/ }).waitFor();
    assert.equal(await page.locator(".nav-item").filter({ hasText: "Batch Modify" }).count(), 0);
    await page.evaluate(() => MF.go("exif-modify", { mode: "self" }));
    await page.locator(".view .drop").first().waitFor();
    return page;
  }

  async function photo(root, name, { date = "2023:05:01 12:00:00", offset = "+08:00", modified = "2024-06-01T01:02:03Z" } = {}) {
    const file = makeJpeg(path.join(root, name));
    const tags = [];
    if (date) tags.push(["DateTimeOriginal", date]);
    if (offset) tags.push(["OffsetTimeOriginal", offset]);
    if (tags.length) await harness.ctx.et.write(file, tags);
    setMtime(file, Date.parse(modified));
    return file;
  }

  await t.test("one loose file keeps its detailed editor", async (t) => {
    const root = tmpDir("modify-ui-single");
    const file = await photo(root, "single.jpg");
    const page = await pageFor(t);
    await dropPaths(page, [file]);
    await currentFile(page, "single.jpg");
    await detailedEditor(page);
    assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isVisible(), true);
    assert.equal(await page.getByTitle("Next", { exact: true }).isVisible(), false);
    assert.equal(await page.locator(".bt-list").isVisible(), false);
  });

  await t.test("mixed loose photos and videos retain individual choices, save in order, and undo together", async (t) => {
    const root = tmpDir("modify-ui-mixed");
    const photoPath = await photo(root, "a-photo.jpg");
    const moviePath = makeMovie(path.join(root, "other", "b-video.mov"));
    await harness.ctx.et.write(moviePath, [["QuickTime:CreateDate", "2022:02:03 04:05:06"]]);
    setMtime(moviePath, Date.parse("2024-07-08T09:10:11Z"));
    const before = [photoPath, moviePath].map((p) => fs.statSync(p).mtimeMs);
    const dirs = [root, path.dirname(moviePath)];
    for (const dir of dirs) setMtime(dir, Date.parse("2020-01-02T03:04:05Z"));
    const page = await pageFor(t);
    await dropPaths(page, [photoPath, moviePath]);
    await currentFile(page, "a-photo.jpg");
    await detailedEditor(page);
    assert.equal(await page.locator(".bt-item").count(), 2);
    assert.match(await page.locator(".stage-bar").textContent(), /1 of 2/);
    await page.getByRole("button", { name: /Everything follows Modified/ }).click();
    await page.locator(".bt-choice.on").filter({ hasText: "Everything follows Modified" }).waitFor();
    await page.getByTitle("Next", { exact: true }).click();
    await currentFile(page, "b-video.mov");
    await detailedEditor(page);
    // The fixture has valid QuickTime dates but no playable video track. Its
    // native video preview may therefore fall back to the format explanation.
    await page.locator(".stage-view").filter({ hasNotText: "Loading…" }).waitFor();
    await page.getByTitle("Previous", { exact: true }).click();
    await currentFile(page, "a-photo.jpg");
    assert.match(await page.locator(".bt-choice.on").textContent(), /Everything follows Modified/);
    const save = page.getByRole("button", { name: "Save & next", exact: true });
    await save.click();
    await currentFile(page, "b-video.mov");
    await page.locator(".bt-list .tab").filter({ hasText: /^Saved/ }).click();
    await currentFile(page, "a-photo.jpg");
    assert.equal(await page.getByTitle("Previous", { exact: true }).isDisabled(), true);
    assert.equal(await page.getByTitle("Next", { exact: true }).isDisabled(), true);
    await page.locator(".bt-list .tab").filter({ hasText: /^To do/ }).click();
    await currentFile(page, "b-video.mov");
    await save.click();
    await page.getByText("All decided", { exact: true }).waitFor();
    assert.equal(fs.statSync(moviePath).mtimeMs, Date.parse("2022-02-03T04:05:06Z"));
    const tags = await readTags(harness.ctx.et, photoPath, ["DateTimeOriginal"]);
    assert.equal(tags.DateTimeOriginal, "2024:06:01 09:02:03");
    for (const dir of dirs) assert.equal(fs.statSync(dir).mtimeMs, Date.parse("2020-01-02T03:04:05Z"));
    await page.getByRole("button", { name: "Undo all", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Undo", exact: true }).click();
    await currentFile(page, "a-photo.jpg");
    assert.deepEqual([photoPath, moviePath].map((p) => fs.statSync(p).mtimeMs), before);
    assert.equal((await readTags(harness.ctx.et, photoPath, ["DateTimeOriginal"])).DateTimeOriginal, "2023:05:01 12:00:00");
    for (const dir of dirs) assert.equal(fs.statSync(dir).mtimeMs, Date.parse("2020-01-02T03:04:05Z"));
  });

  await t.test("recursive folders include agreeing, unzoned and undated files and support skipping", async (t) => {
    const root = tmpDir("modify-ui-folder");
    const now = Date.now();
    const wall = new Date(now + 8 * 3600000).toISOString().slice(0, 19).replace(/-/g, ":").replace("T", " ");
    const agree = await photo(root, "a-agrees.jpg", { date: wall, modified: new Date(now).toISOString() });
    const unzoned = await photo(root, "nested/b-unzoned.jpg", { offset: null });
    const undated = await photo(root, "nested/c-undated.jpg", { date: null, offset: null });
    fs.writeFileSync(path.join(root, "ignored.txt"), "not media");
    const page = await pageFor(t);
    await dropPaths(page, [root, agree]);
    await currentFile(page, "a-agrees.jpg");
    await detailedEditor(page);
    assert.equal(await page.locator(".bt-item").count(), 3, "overlapping folder and file selections are deduplicated");
    assert.match(await page.locator(".bt-counts").textContent(), /[1-9]\d* already agree/);
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    await currentFile(page, "b-unzoned.jpg");
    await page.getByText("Choose a time zone to save.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Save & next", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Beijing", exact: true }).click();
    await page.locator(".bt-chip.on").filter({ hasText: "Beijing" }).waitFor();
    await page.getByTitle("Next", { exact: true }).click();
    await currentFile(page, "c-undated.jpg");
    await detailedEditor(page);
    assert.match(await page.locator(".bt-field").first().textContent(), /none/);
    assert.equal(await page.getByRole("button", { name: /Everything follows the EXIF date/ }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: /Everything follows Modified/ }).isEnabled(), true);
    await page.getByTitle("Previous", { exact: true }).click();
    await currentFile(page, "b-unzoned.jpg");
    assert.equal(await page.locator(".bt-chip.on").filter({ hasText: "Beijing" }).count(), 1);
    assert.equal(fs.statSync(unzoned).mtimeMs, Date.parse("2024-06-01T01:02:03Z"), "navigation does not save decisions");
    assert.equal(fs.statSync(undated).mtimeMs, Date.parse("2024-06-01T01:02:03Z"));
    await page.locator(".bt-list .tab").filter({ hasText: /^Skipped/ }).click();
    await currentFile(page, "a-agrees.jpg");
    assert.equal(await page.getByTitle("Previous", { exact: true }).isDisabled(), true);
    assert.equal(await page.getByTitle("Next", { exact: true }).isDisabled(), true);
    await page.locator(".bt-list .tab").filter({ hasText: /^To do/ }).click();
    await currentFile(page, "b-unzoned.jpg");
    assert.equal(await page.locator(".bt-chip.on").filter({ hasText: "Beijing" }).count(), 1);
  });

  await t.test("a folder containing one file still offers queue navigation and Skip", async (t) => {
    const root = tmpDir("modify-ui-small-folder");
    await photo(root, "only.jpg");
    const page = await pageFor(t);
    await dropPaths(page, [root]);
    await currentFile(page, "only.jpg");
    await detailedEditor(page);
    assert.equal(await page.getByRole("button", { name: "Skip", exact: true }).isVisible(), true);
    assert.equal(await page.getByTitle("Next", { exact: true }).isVisible(), true);
  });

  await t.test("a previous file's delayed outcome cannot repaint the next file or enable saving while it loads", async (t) => {
    const root = tmpDir("modify-ui-outcome-race");
    const old = await photo(root, "a-old.jpg", { date: "2001:01:01 01:01:01" });
    const fresh = await photo(root, "b-fresh.jpg", { date: "2010:02:03 04:05:06" });
    const page = await pageFor(t);
    let releaseOld;
    let releaseFresh;
    let oldReady;
    let freshReady;
    const oldGate = new Promise((resolve) => { releaseOld = resolve; });
    const freshGate = new Promise((resolve) => { releaseFresh = resolve; });
    const oldOutcome = new Promise((resolve) => { oldReady = resolve; });
    const freshOutcome = new Promise((resolve) => { freshReady = resolve; });
    t.after(() => { releaseOld(); releaseFresh(); });
    await page.route("**/task", async (route) => {
      const request = route.request().postDataJSON();
      if (request.name === "exif.batchOutcome") {
        const response = await route.fetch();
        if (request.payload.path === old) {
          oldReady();
          await oldGate;
        } else {
          freshReady();
          await freshGate;
        }
        await route.fulfill({ response });
      } else await route.continue();
    });
    await dropPaths(page, [old, fresh]);
    await oldOutcome;
    await page.locator(".stage .fname").filter({ hasText: "a-old.jpg" }).waitFor();
    await page.getByTitle("Next", { exact: true }).click();
    await freshOutcome;
    const response = page.waitForResponse((res) => res.url().endsWith("/task") && res.request().postDataJSON().name === "exif.batchOutcome" && res.request().postDataJSON().payload.path === old);
    releaseOld();
    await (await response).finished();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator(".stage .fname").textContent(), "b-fresh.jpg");
    assert.doesNotMatch(await page.locator(".bt-side").textContent(), /2001-01-01/);
    const save = page.getByRole("button", { name: "Save & next", exact: true });
    assert.equal(await save.count() === 0 || await save.isDisabled(), true);
    releaseFresh();
    await currentFile(page, "b-fresh.jpg");
    assert.match(await page.locator(".bt-field").first().textContent(), /2010-02-03/);
  });

  await t.test("changing the dropped files during Save waits for that save and opens a usable new editor", async (t) => {
    const root = tmpDir("modify-ui-save-race");
    const old = await photo(root, "old.jpg");
    const fresh = await photo(root, "fresh.jpg", { date: "2010:02:03 04:05:06" });
    const page = await pageFor(t);
    let release;
    let applied;
    let didDelay = false;
    const gate = new Promise((resolve) => { release = resolve; });
    const firstApply = new Promise((resolve) => { applied = resolve; });
    t.after(() => release());
    await page.route("**/task", async (route) => {
      const request = route.request().postDataJSON();
      if (!didDelay && request.name === "exif.batchApply") {
        didDelay = true;
        const response = await route.fetch();
        applied();
        await gate;
        await route.fulfill({ response });
      } else await route.continue();
    });
    await dropPaths(page, [old]);
    await currentFile(page, "old.jpg");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await firstApply;
    assert.equal(fs.statSync(old).mtimeMs, Date.parse("2023-05-01T04:00:00Z"));
    await page.locator(".drop .item").getByTitle("Remove", { exact: true }).click();
    await dropPaths(page, [fresh]);
    await page.getByText("Finishing the current save…", { exact: true }).waitFor();
    assert.equal(await page.locator(".stage .fname").isVisible(), false);
    assert.equal(fs.statSync(fresh).mtimeMs, Date.parse("2024-06-01T01:02:03Z"));
    release();
    await currentFile(page, "fresh.jpg");
    assert.match(await page.locator(".bt-field").first().textContent(), /2010-02-03/);
    const save = page.getByRole("button", { name: "Save", exact: true });
    assert.equal(await save.isEnabled(), true);
    await save.click();
    await page.getByText("Saved. Folder dates were kept.", { exact: true }).waitFor();
    assert.equal(fs.statSync(fresh).mtimeMs, Date.parse("2010-02-02T20:05:06Z"));
  });

  for (const action of ["removing a selection", "clearing the screen"]) await t.test(`${action} ignores its delayed scan when replacement files finish first`, async (t) => {
    const root = tmpDir("modify-ui-race");
    const old = await photo(root, "old.jpg");
    const fresh = await photo(root, "fresh.jpg");
    const page = await pageFor(t);
    let release;
    let scanned;
    let didDelay = false;
    const gate = new Promise((resolve) => { release = resolve; });
    const firstScan = new Promise((resolve) => { scanned = resolve; });
    await page.route("**/task", async (route) => {
      const request = route.request().postDataJSON();
      if (!didDelay && request.name === "exif.batchScan") {
        didDelay = true;
        const response = await route.fetch();
        scanned();
        await gate;
        await route.fulfill({ response });
      } else await route.continue();
    });
    // Always release a delayed request if an assertion fails.
    t.after(() => release());
    await dropPaths(page, [old]);
    await firstScan;
    if (action === "removing a selection") {
      await page.locator(".drop .item").getByTitle("Remove", { exact: true }).click();
    } else {
      await page.getByRole("button", { name: "Clear", exact: true }).click();
      await page.evaluate(() => MF.go("exif-modify", { mode: "self" }));
    }
    await dropPaths(page, [fresh]);
    await currentFile(page, "fresh.jpg");
    const response = page.waitForResponse((res) => res.url().endsWith("/task") && res.request().postDataJSON().name === "exif.batchScan");
    release();
    await (await response).finished();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator(".stage .fname").textContent(), "fresh.jpg");
    assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isVisible(), true);
    assert.equal(await page.locator(".drop .item .name").textContent(), "fresh.jpg");
  });

  assert.deepEqual(errors, [], "renderer has no unhandled errors");
});

"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { createServer } = require("./harness/server");
const { makeJpeg, tmpDir, setMtime } = require("./helpers");
function browserTools() {
  for (const name of [
    "playwright",
    "playwright-core",
    "/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core",
  ])
    try {
      const chromium = require(name).chromium;
      const executablePath = [
        process.env.MYFILE_TEST_CHROMIUM,
        chromium.executablePath(),
        "/usr/bin/chromium",
        "/usr/bin/google-chrome",
      ].find((p) => p && fs.existsSync(p));
      if (executablePath) return { chromium, executablePath };
    } catch (e) {
      if (e.code !== "MODULE_NOT_FOUND") throw e;
    }
  return null;
}
test(
  "display preferences apply live, preserve reviews/data, persist, and travel with HTML reports",
  { timeout: 120000 },
  async (t) => {
    const tools = browserTools();
    if (!tools)
      return t.skip("Browser regression checks require Playwright/Chromium.");
    const app = createServer({ dataDir: tmpDir("presentation-ui") });
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    t.after(() => app.close());
    const browser = await tools.chromium.launch({
      executablePath: tools.executablePath,
      args: ["--no-sandbox"],
    });
    t.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
      timezoneId: "Asia/Shanghai",
    });
    t.after(() => page.close());
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const root = tmpDir("presentation-files");
    const photo = makeJpeg(path.join(root, "Saved 2023-05-01 14:00.jpg"));
    await app.ctx.et.write(photo, [
      ["DateTimeOriginal", "2015:12:29 14:28:42"],
      ["OffsetTimeOriginal", "-05:00"],
      ["LensModel", "Save"],
    ]);
    setMtime(photo, Date.parse("2024-01-01T00:00:00Z"));
    const originalMs = fs.statSync(photo).mtimeMs;
    const hash = () =>
      crypto.createHash("sha256").update(fs.readFileSync(photo)).digest("hex");
    const originalHash = hash();
    const url = `http://127.0.0.1:${app.server.address().port}`;
    await page.goto(url);
    await page.locator(".header h1").filter({ hasText: /\S/ }).waitFor();
    await page.evaluate(
      (photo) => MF.go("exif-modify", { mode: "self", paths: [photo] }),
      photo,
    );
    await page
      .getByRole("button", { name: /Everything follows Modified/ })
      .click();
    await page
      .locator(".bt-choice.on")
      .filter({ hasText: "Everything follows Modified" })
      .waitFor();
    await page.evaluate(() => MF.go("settings"));
    await page.getByRole("radio", { name: "简体中文", exact: true }).click();
    await page.getByText("应用语言", { exact: true }).waitFor();
    await page
      .getByRole("radio", { name: "12 小时制（AM/PM）", exact: true })
      .click();
    await page.waitForFunction(
      () => MF.settings.language === "zh-CN" && MF.settings.timeFormat === "12",
    );
    assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
    await page.setViewportSize({ width: 1000, height: 660 });
    await page.evaluate(() => MF.go("exif-modify", { mode: "self" }));
    await page.getByRole("button", { name: /全部按修改日期/ }).waitFor();
    assert.match(
      await page.locator(".bt-choice.on").textContent(),
      /全部按修改日期/,
      "changing presentation retains the unsaved choice",
    );
    assert.equal(
      await page.locator(".stage .fname").textContent(),
      "Saved 2023-05-01 14:00.jpg",
    );
    assert.match(
      await page.locator(".bt-field").first().locator(".bt-now").innerText(),
      /2015-12-29 02:28:42 PM UTC-05:00/,
    );
    assert.equal(hash(), originalHash);
    assert.equal(
      fs.statSync(photo).mtimeMs,
      originalMs,
      "preferences do not write file dates",
    );
    const saveBounds = await page
      .getByRole("button", { name: "保存", exact: true })
      .boundingBox();
    assert.ok(
      saveBounds.y + saveBounds.height <= 660,
      "Chinese and AM/PM keep Save inside the small window",
    );
    assert.ok(
      await page
        .locator(".content")
        .evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
    );
    for (const [view, title] of [
      ["home", "概览"],
      ["folder-compare", "比较"],
      ["folder-modify", "修改"],
      ["folder-html", "生成 HTML"],
      ["filesync", "文件同步"],
      ["history", "历史记录"],
    ]) {
      await page.evaluate((view) => MF.go(view), view);
      await page.locator(".header h1").filter({ hasText: title }).waitFor();
    }
    await page.evaluate(
      (photo) => MF.go("exif-show", { paths: [photo] }),
      photo,
    );
    await page
      .getByRole("button", { name: "用于设置文件日期", exact: true })
      .waitFor();
    assert.match(
      await page.locator(".big-date .when").innerText(),
      /02:28:42 PM UTC-05:00/,
    );
    assert.equal(
      await page.locator(".fname").textContent(),
      "Saved 2023-05-01 14:00.jpg",
    );
    assert.equal(
      await page
        .locator(".tagrow")
        .filter({ has: page.locator(".k", { hasText: /^文件名$/ }) })
        .locator(".v > span")
        .textContent(),
      "Saved 2023-05-01 14:00.jpg",
      "date-like filenames remain exact even in the raw metadata list",
    );
    const lens = page
      .locator(".kvr")
      .filter({ has: page.locator(".k", { hasText: "镜头" }) });
    assert.equal(
      await lens.locator(".v").innerText(),
      "Save",
      "metadata values are never translated",
    );
    const tagSearch = page.locator(".panel-side .input input");
    await tagSearch.fill("文件名");
    await page.waitForFunction(
      () => document.querySelectorAll(".tagrow").length === 1,
    );
    assert.equal(
      await page.locator(".tagrow .k").textContent(),
      "文件名",
      "Chinese metadata labels remain searchable",
    );
    await tagSearch.fill("");
    await page.waitForFunction(
      () => document.querySelectorAll(".tagrow").length > 1,
    );
    // Save through the actual Chinese UI: selected source and canonical timestamps
    // stay independent from their localized clock strings.
    await page
      .getByRole("button", { name: "用于设置文件日期", exact: true })
      .click();
    await page.getByRole("button", { name: /全部按 EXIF 日期/ }).click();
    const saved = page.waitForResponse(
      (r) =>
        r.url().endsWith("/task") &&
        r.request().postDataJSON().name === "exif.batchApply",
    );
    await page.getByRole("button", { name: "保存", exact: true }).click();
    assert.equal((await (await saved).json()).result.ok, 1);
    await page.getByRole("button", { name: "撤销", exact: true }).waitFor();
    assert.equal(
      fs.statSync(photo).mtimeMs,
      Date.parse("2015-12-29T19:28:42Z"),
    );
    assert.equal(
      hash(),
      originalHash,
      "clock/language preferences do not rewrite EXIF",
    );
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    const undo = page.waitForResponse(
      (r) =>
        r.url().endsWith("/task") &&
        r.request().postDataJSON().name === "history.revert",
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "撤销", exact: true })
      .click();
    assert.equal((await (await undo).json()).result.pending, 0);
    assert.equal(fs.statSync(photo).mtimeMs, originalMs);
    await page.evaluate(() => MF.go("settings"));
    await page.getByText("应用语言", { exact: true }).waitFor();
    await page.reload();
    await page.getByText("应用语言", { exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole("radio", { name: "12 小时制（AM/PM）", exact: true })
        .getAttribute("aria-checked"),
      "true",
    );
    assert.equal(
      await page
        .getByRole("radio", { name: "简体中文", exact: true })
        .getAttribute("aria-checked"),
      "true",
    );
    const second = await browser.newPage();
    t.after(() => second.close());
    await second.goto(url);
    await second.locator(".header h1").filter({ hasText: /\S/ }).waitFor();
    await second.evaluate(() => MF.go("settings"));
    await second.getByText("应用语言", { exact: true }).waitFor();
    assert.equal(await second.locator("html").getAttribute("lang"), "zh-CN");
    // Reports remain self-contained, retain canonical embedded data for restoring
    // dates, and use their export-time language/clock preferences in any zone.
    const { createHandlers } = require("../src/main/handlers");
    const handlers = createHandlers(app.ctx),
      task = { progress() {} };
    const out = tmpDir("localized-reports"),
      index = path.join(out, "index.html"),
      report = path.join(out, "report.html");
    await handlers["folder.index"]({ folder: root, output: index }, task);
    const other = tmpDir("comparison");
    makeJpeg(path.join(other, "different.jpg"));
    const comparison = await handlers["folder.compare"](
      { a: root, b: other },
      task,
    );
    await handlers["folder.compareExport"](
      { id: comparison.id, output: report },
      task,
    );
    const snapshots = [];
    for (const zone of ["UTC", "America/New_York"]) {
      const reportPage = await browser.newPage({ timezoneId: zone });
      const texts = [];
      for (const file of [index, report]) {
        await reportPage.goto(url + "/file?p=" + encodeURIComponent(file));
        await reportPage.waitForFunction(
          () => document.documentElement.lang === "zh-CN",
        );
        const text = await reportPage.locator("body").innerText();
        assert.match(text, /AM|PM/);
        assert.match(text, /创建|修改/);
        texts.push(text);
        const data = await reportPage
          .locator('script[type="application/json"]')
          .first()
          .textContent();
        assert.doesNotMatch(
          data,
          /\b(?:AM|PM)\b/,
          "canonical report data is not localized",
        );
      }
      snapshots.push(texts);
      await reportPage.close();
    }
    assert.deepEqual(snapshots[1], snapshots[0]);
    await page.getByRole("radio", { name: "English", exact: true }).click();
    await page.getByText("App language", { exact: true }).waitFor();
    await page.getByRole("radio", { name: "24-hour", exact: true }).click();
    await page.waitForFunction(
      () => MF.settings.language === "en" && MF.settings.timeFormat === "24",
    );
    await page.evaluate(
      (photo) => MF.go("exif-show", { paths: [photo] }),
      photo,
    );
    await page
      .getByRole("button", { name: "Use for file dates", exact: true })
      .waitFor();
    assert.equal(
      await page.locator(".big-date .when").innerText(),
      "2015-12-29 14:28:42 UTC-05:00",
    );
    assert.equal(hash(), originalHash);
    assert.deepEqual(errors, []);
  },
);

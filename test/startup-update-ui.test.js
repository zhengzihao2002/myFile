"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createServer } = require("./harness/server");
const { tmpDir } = require("./helpers");

function browserTools() {
  for (const name of ["playwright", "playwright-core", "/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core"]) {
    try {
      const chromium = require(name).chromium;
      const executablePath = [process.env.MYFILE_TEST_CHROMIUM, chromium.executablePath(), "/usr/bin/chromium"].find(p => p && fs.existsSync(p));
      if (executablePath) return { chromium, executablePath };
    } catch (err) { if (err.code !== "MODULE_NOT_FOUND") throw err; }
  }
  return null;
}

test("launch checks for updates silently and only updates after the user's choice", { timeout: 90000 }, async t => {
  const tools = browserTools();
  if (!tools) return t.skip("Browser regression checks require Playwright/Chromium.");
  const app = createServer({ dataDir: tmpDir("launch-updates") });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const browser = await tools.chromium.launch({ executablePath: tools.executablePath, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const errors = [];

  async function launch(t, { behind = 0, offline = false, gate = null } = {}) {
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", err => errors.push(err.message));
    t.after(() => page.close());
    const calls = { checks: 0, applies: 0 };
    // Stand in for the installed Electron preload while retaining the real UI
    // and backend for all other operations. Update routes never access GitHub
    // or rebuild the app during these tests.
    await page.route("**/test/harness/bridge.js", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()) + "\nwindow.myfile = window.myfileHarness;" });
    });
    await page.route("**/task", async route => {
      const task = route.request().postDataJSON();
      if (task.name === "update.check") {
        calls.checks++;
        if (gate) await gate;
        await route.fulfill({ json: offline ? { ok: false, error: "Offline for test" } : { ok: true, result: { behind, canRestart: true, current: "current version", commits: ["A newer version"], dirty: [], ahead: 0 } } });
      } else if (task.name === "update.apply") {
        calls.applies++;
        await route.fulfill({ json: { ok: true, result: {} } });
      } else await route.continue();
    });
    const requested = page.waitForRequest(r => r.url().endsWith("/task") && r.postDataJSON().name === "update.check");
    const checked = page.waitForResponse(r => r.url().endsWith("/task") && r.request().postDataJSON().name === "update.check");
    await page.goto(url);
    await page.locator(".header h1").filter({ hasText: /\S/ }).waitFor();
    await requested;
    return { page, calls, checked };
  }

  await t.test("current versions do not show a prompt, progress overlay or toast", async t => {
    const { page, calls, checked } = await launch(t);
    await checked;
    await page.waitForTimeout(100);
    assert.equal(calls.checks, 1);
    assert.equal(await page.locator(".modal-back,.busy,.toast").count(), 0);
    await page.evaluate(() => MF.go("settings"));
    await page.getByText("App language", { exact: true }).waitFor();
    assert.equal(calls.checks, 1, "navigation does not repeat the launch check");
    assert.equal(calls.applies, 0);
    await page.evaluate(() => MF.checkForUpdates());
    await page.getByText("myFile is up to date", { exact: true }).waitFor();
    assert.equal(calls.checks, 2, "manual checks still report the current version");
  });

  await t.test("an available update prompts, and Not now keeps the app open without updating", async t => {
    const { page, calls } = await launch(t, { behind: 1 });
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    assert.match(await dialog.textContent(), /1 update available/);
    assert.equal(calls.applies, 0);
    await dialog.getByRole("button", { name: "Not now", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(calls.applies, 0);
    assert.equal(await page.locator(".header h1").isVisible(), true);
  });

  await t.test("accepting the prompt runs the existing update workflow once", async t => {
    const { page, calls } = await launch(t, { behind: 2 });
    await page.getByRole("dialog").getByRole("button", { name: "Update and restart", exact: true }).click();
    await page.getByText("Rebuilding myFile…", { exact: true }).waitFor();
    assert.equal(calls.applies, 1);
  });

  await t.test("offline launch checks stay silent while manual checks still explain errors", async t => {
    const { page, calls, checked } = await launch(t, { offline: true });
    await checked;
    await page.waitForTimeout(100);
    assert.equal(await page.locator(".modal-back,.busy,.toast").count(), 0);
    await page.evaluate(() => MF.checkForUpdates());
    await page.getByText("Offline for test", { exact: true }).waitFor();
    assert.equal(calls.checks, 2);
    assert.equal(calls.applies, 0);
  });

  await t.test("a manual check during the launch check does not duplicate requests or prompts", async t => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const { page, calls } = await launch(t, { behind: 1, gate });
    await page.waitForFunction(() => Boolean(MF.checkForUpdates));
    await page.evaluate(() => { window.__menu({ action: "check-updates" }); });
    assert.equal(calls.checks, 1);
    release();
    await page.getByRole("dialog").waitFor();
    assert.equal(await page.getByRole("dialog").count(), 1);
    assert.equal(calls.checks, 1);
    await page.getByRole("dialog").getByRole("button", { name: "Not now", exact: true }).click();
    assert.equal(calls.applies, 0);
  });

  await t.test("a manual check joining the background check still receives up-to-date feedback", async t => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const { page, calls } = await launch(t, { gate });
    await page.evaluate(() => { window.__menu({ action: "check-updates" }); });
    release();
    await page.getByText("myFile is up to date", { exact: true }).waitFor();
    assert.equal(calls.checks, 1);
    assert.equal(calls.applies, 0);
  });

  await t.test("the update prompt uses the selected app language", async t => {
    app.ctx.settings.set({ language: "zh-CN" });
    const { page, calls } = await launch(t, { behind: 1 });
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    assert.match(await dialog.textContent(), /有 1 项更新可用/);
    await dialog.getByRole("button", { name: "暂不更新", exact: true }).click();
    assert.equal(calls.applies, 0);
  });

  assert.deepEqual(errors, []);
});

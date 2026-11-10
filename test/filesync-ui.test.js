"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createServer } = require("./harness/server");
const { tmpDir, makeTree } = require("./helpers");

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

async function dropReference(page, reference) {
  await page.locator(".view .drop").first().evaluate((el, reference) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", reference);
    el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
  }, reference);
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test("FileSync keeps tree responses attached to the reference that requested them", { timeout: 120000 }, async (t) => {
  const available = browserTools();
  if (available.reason) return t.skip(available.reason);
  const harness = createServer({ dataDir: tmpDir("sync-ui-data") });
  await new Promise((resolve) => harness.server.listen(0, "127.0.0.1", resolve));
  t.after(() => harness.close());
  const browser = await available.chromium.launch({ executablePath: available.executablePath, headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const errors = [];
  const a = makeTree(tmpDir("sync-a"), { "a-only.txt": "a", "same/old-child.txt": "old" });
  const b = makeTree(tmpDir("sync-b"), { "b-only.txt": "b", "same/new-child.txt": "new" });

  async function pageFor(t) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    page.setDefaultTimeout(10000);
    page.on("pageerror", (err) => errors.push(err.message));
    t.after(() => page.close());
    await page.goto(`http://127.0.0.1:${harness.server.address().port}`);
    await page.locator(".header h1").filter({ hasText: /\S/ }).waitFor();
    await page.evaluate(() => MF.go("filesync"));
    await page.getByRole("radio", { name: "Choose items", exact: true }).click();
    return page;
  }

  for (const fail of [false, true]) await t.test(`replacement ignores the old tree's delayed ${fail ? "error" : "success"}`, async (t) => {
    const page = await pageFor(t);
    const started = deferred();
    const gate = deferred();
    const finished = deferred();
    let rootReads = 0;
    await page.route("**/task", async (route) => {
      const req = route.request().postDataJSON();
      if (req.name === "sync.tree" && req.payload.reference === a) {
        rootReads++;
        const response = await route.fetch();
        started.resolve();
        await gate.promise;
        if (fail) await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: false, error: "old reference failed" }) });
        else await route.fulfill({ response });
        finished.resolve();
      } else await route.continue();
    });
    t.after(() => gate.resolve());
    await dropReference(page, a);
    await started.promise;
    // Option edits while the first request is pending must reuse it.
    await page.locator(".option").filter({ hasText: "Put the clone in a subfolder" }).click();
    await page.getByRole("radio", { name: /Size only/ }).click();
    assert.equal(rootReads, 1);
    await dropReference(page, b);
    await page.locator(".tree .nm").filter({ hasText: "b-only.txt" }).waitFor();
    gate.resolve();
    await finished.promise;
    await settle(page);
    assert.deepEqual(await page.locator(".tree .nm").allTextContents(), ["b-only.txt", "same"]);
    assert.equal(await page.getByText("old reference failed", { exact: true }).count(), 0);
  });

  await t.test("a delayed subfolder expansion cannot replace a new reference's same-named subfolder", async (t) => {
    const page = await pageFor(t);
    await dropReference(page, a);
    await page.locator(".tree .nm").filter({ hasText: "a-only.txt" }).waitFor();
    const started = deferred(), gate = deferred(), finished = deferred();
    await page.route("**/task", async (route) => {
      const req = route.request().postDataJSON();
      if (req.name === "sync.children" && req.payload.reference === a) {
        const response = await route.fetch();
        started.resolve();
        await gate.promise;
        await route.fulfill({ response });
        finished.resolve();
      } else await route.continue();
    });
    t.after(() => gate.resolve());
    await page.locator(".tnode").filter({ has: page.locator(".nm", { hasText: /^same$/ }) }).locator(".tw").click();
    await started.promise;
    await dropReference(page, b);
    await page.locator(".tree .nm").filter({ hasText: "b-only.txt" }).waitFor();
    await page.locator(".tnode").filter({ has: page.locator(".nm", { hasText: /^same$/ }) }).locator(".tw").click();
    await page.locator(".tree .nm").filter({ hasText: "new-child.txt" }).waitFor();
    gate.resolve();
    await finished.promise;
    await settle(page);
    assert.deepEqual(await page.locator(".tree .nm").allTextContents(), ["b-only.txt", "same", "new-child.txt"]);
    assert.equal(await page.locator(".tree .nm").filter({ hasText: "old-child.txt" }).count(), 0);
    assert.equal(await page.locator(".tree [aria-checked=true]").count(), 0, "the replacement has no previous selection");
  });

  await t.test("Clear invalidates an in-flight root request", async (t) => {
    const page = await pageFor(t);
    const started = deferred(), gate = deferred(), finished = deferred();
    await page.route("**/task", async (route) => {
      const req = route.request().postDataJSON();
      if (req.name === "sync.tree" && req.payload.reference === a) {
        const response = await route.fetch();
        started.resolve();
        await gate.promise;
        await route.fulfill({ response });
        finished.resolve();
      } else await route.continue();
    });
    t.after(() => gate.resolve());
    await dropReference(page, a);
    await started.promise;
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    gate.resolve();
    await finished.promise;
    await settle(page);
    assert.equal(await page.locator(".tree .nm").count(), 0);
    assert.equal(await page.locator(".drop .item").count(), 0);
    await dropReference(page, b);
    await page.locator(".tree .nm").filter({ hasText: "b-only.txt" }).waitFor();
    assert.deepEqual(await page.locator(".tree .nm").allTextContents(), ["b-only.txt", "same"]);
  });
  assert.deepEqual(errors, []);
});

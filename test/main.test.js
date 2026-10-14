"use strict";

// Loads the real main.js and preload.js against a stand-in for the electron
// module, to check the wiring (paths, IPC, menu, quit) without Electron.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const { tmpDir } = require("./helpers");

function fakeElectron() {
  const app = new EventEmitter();
  const paths = {};
  let readyResolve;
  const ready = new Promise((r) => (readyResolve = r));
  Object.assign(app, {
    isPackaged: false,
    setName: (n) => (app.name = n),
    setPath: (k, v) => {
      assert.ok(path.isAbsolute(v), `${k} must be absolute`);
      assert.ok(fs.existsSync(v), `${k} folder must exist before setPath`);
      paths[k] = v;
    },
    setAppLogsPath: (v) => (paths.logs = v),
    getVersion: () => "1.0.0",
    requestSingleInstanceLock: () => true,
    quit: () => app.emit("will-quit"),
    whenReady: () => ready,
    setAboutPanelOptions: (o) => (app.about = o),
    dock: { setIcon: () => {} },
    paths,
    fireReady: () => readyResolve(),
  });
  const handlers = new Map();
  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this.sent = [];
      this.webContents = Object.assign(new EventEmitter(), { send: (...a) => this.sent.push(a), isLoading: () => false, isDestroyed: () => false });
      windows.push(this);
    }
    loadFile(f) {
      this.loaded = f;
    }
    show() {}
    maximize() {}
    isMaximized() {
      return false;
    }
    isMinimized() {
      return false;
    }
    getNormalBounds() {
      return { x: 0, y: 0, width: 1200, height: 800 };
    }
    setBackgroundColor() {}
    static fromWebContents() {
      return windows[0];
    }
  }
  let menu = null;
  let exposed = null;
  return {
    app,
    BrowserWindow,
    windows,
    handlers,
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    ipcRenderer: Object.assign(new EventEmitter(), { invoke: async (ch, arg) => handlers.get(ch)({ senderFrame: { url: `file://${path.resolve(__dirname, "..", "src", "renderer", "index.html")}` }, sender: { send: () => {}, isDestroyed: () => false } }, arg) }),
    contextBridge: { exposeInMainWorld: (k, v) => (exposed = { k, v }) },
    webUtils: { getPathForFile: (f) => f.path },
    dialog: { showOpenDialog: async () => ({ canceled: true }), showSaveDialog: async () => ({ canceled: true }) },
    shell: { trashItem: async () => {}, showItemInFolder: () => {}, openPath: async () => "", openExternal: async () => {} },
    Menu: { buildFromTemplate: (t) => t, setApplicationMenu: (m) => (menu = m) },
    nativeTheme: { themeSource: "system", shouldUseDarkColors: false },
    powerSaveBlocker: { start: () => 1, stop: () => {}, isStarted: () => true },
    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] },
    get menu() {
      return menu;
    },
    get exposed() {
      return exposed;
    },
  };
}

test("main.js sets up paths, IPC, menu and quits cleanly; preload exposes the API", async () => {
  const dataDir = tmpDir("main");
  process.env.MYFILE_DATA_DIR = dataDir;
  const electron = fakeElectron();
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "electron") return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const mainPath = require.resolve("../src/main/main.js");
    delete require.cache[mainPath];
    require(mainPath);

    // Every Chromium folder lives inside the data folder.
    for (const key of ["userData", "sessionData", "crashDumps", "logs"]) {
      assert.ok(electron.app.paths[key].startsWith(dataDir), `${key} is inside the data folder`);
    }
    assert.equal(electron.app.paths.temp, undefined, "Chromium's temp stays in the system temp folder");

    electron.app.fireReady();
    await new Promise((r) => setImmediate(r));
    assert.equal(electron.windows.length, 1);
    const win = electron.windows[0];
    assert.ok(win.loaded.endsWith(path.join("src", "renderer", "index.html")));
    assert.equal(win.opts.webPreferences.contextIsolation, true);
    assert.equal(win.opts.webPreferences.sandbox, true);
    assert.equal(win.opts.webPreferences.nodeIntegration, false);
    assert.ok(electron.menu.some((m) => m.label === "Go"));

    // IPC: a task runs, unknown senders are refused.
    const task = electron.handlers.get("myfile:task");
    const okEvent = { senderFrame: { url: `file://${path.resolve(__dirname, "..", "src", "renderer", "index.html")}` }, sender: { send: () => {}, isDestroyed: () => false } };
    const info = await task(okEvent, { id: "t1", name: "app.info", payload: {} });
    assert.equal(info.ok, true, JSON.stringify(info));
    assert.equal(info.result.dataDir, dataDir);
    assert.match(info.result.exiftoolVersion, /^\d+\.\d+/);
    const denied = await task({ senderFrame: { url: "https://evil.example/" }, sender: okEvent.sender }, { id: "t2", name: "app.info" });
    assert.equal(denied.ok, false);
    const unknown = await task(okEvent, { id: "t3", name: "nope" });
    assert.equal(unknown.ok, false);

    // Preload exposes a fixed API that round-trips through IPC.
    const preloadPath = require.resolve("../src/main/preload.js");
    delete require.cache[preloadPath];
    require(preloadPath);
    assert.equal(electron.exposed.k, "myfile");
    const api = electron.exposed.v;
    for (const fn of ["task", "cancel", "pathForFile", "dialog", "reveal", "open", "openExternal", "setTheme", "onMenu"]) assert.equal(typeof api[fn], "function", fn);
    const viaPreload = await api.task("t4", "settings.get", {});
    assert.equal(viaPreload.ok, true);
    assert.equal(api.pathForFile({ path: "/x/y" }), "/x/y");

    electron.app.emit("will-quit");
  } finally {
    Module._load = originalLoad;
  }
});

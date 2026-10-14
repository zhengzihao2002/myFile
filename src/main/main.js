"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, screen, powerSaveBlocker } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { resolveRuntime } = require("./lib/runtime");
const { ExifTool } = require("./lib/exiftool");
const janitor = require("./lib/janitor");
const { createContext, createHandlers, invoke } = require("./handlers");
const { readJson, writeJson } = require("./lib/store");

// ---------------------------------------------------------------------------
// Where things live. This must run before anything asks Electron for its
// data folder: by default Chromium would create ~/Library/Application
// Support/myFile; instead everything goes inside the project folder.
// ---------------------------------------------------------------------------

const runtime = resolveRuntime({
  isPackaged: app.isPackaged,
  execPath: process.execPath,
  resourcesPath: process.resourcesPath,
  mainDir: __dirname,
});
const chromiumDir = path.join(runtime.dataDir, "chromium");
const crashDir = path.join(chromiumDir, "crashes");
const logsDir = path.join(runtime.dataDir, "logs");
// Electron's docs ask for these to exist before they are set.
for (const dir of [chromiumDir, crashDir, logsDir, runtime.tmpDir]) fs.mkdirSync(dir, { recursive: true });
app.setName("myFile");
app.setPath("userData", chromiumDir);
app.setPath("sessionData", chromiumDir);
app.setPath("crashDumps", crashDir);
app.setAppLogsPath(logsDir);
// Chromium's own temp files (like the single-instance socket, whose path
// must stay short) stay in macOS's per-user temp folder, which the system
// cleans up by itself. myFile's own scratch files go to runtime.tmpDir.

const IS_MAC = process.platform === "darwin";
const DEV = !app.isPackaged || process.env.MYFILE_DEV === "1";
const RENDERER = path.join(__dirname, "..", "renderer", "index.html");
const RENDERER_URL = pathToFileURL(RENDERER).href;
const ICON_PNG = path.join(__dirname, "..", "..", "assets", "icon.png");
const VERSION = app.getVersion();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start() {
  if (app.isPackaged) janitor.sweepNow(runtime.bundleId);
  for (const dir of [runtime.tmpDir, runtime.previewDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }

  const et = new ExifTool({ perl: runtime.perl, script: runtime.exiftool, size: 2 });
  const ctx = createContext({
    runtime,
    et,
    appVersion: VERSION,
    trash: (p) => shell.trashItem(p),
    fileUrl: (p) => pathToFileURL(p).href,
    extraInfo: { packaged: app.isPackaged, bundleId: runtime.bundleId },
    // Long syncs to an external drive keep the Mac from sleeping mid-copy.
    keepAwake: () => {
      const id = powerSaveBlocker.start("prevent-app-suspension");
      return () => {
        if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id);
      };
    },
  });
  const handlers = createHandlers(ctx);
  const running = new Map();
  let win = null;

  // -------------------------------------------------------------------------
  // Security: the window only ever shows our own page.
  // -------------------------------------------------------------------------
  app.on("web-contents-created", (_e, contents) => {
    contents.on("will-navigate", (event, url) => {
      if (url !== RENDERER_URL) event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
  });

  const fromUs = (event) => {
    const url = event.senderFrame && event.senderFrame.url;
    return typeof url === "string" && url.startsWith(RENDERER_URL);
  };

  // -------------------------------------------------------------------------
  // IPC
  // -------------------------------------------------------------------------
  ipcMain.handle("myfile:task", async (event, { id, name, payload }) => {
    if (!fromUs(event)) return { ok: false, error: "Not allowed" };
    const controller = new AbortController();
    running.set(id, controller);
    const sender = event.sender;
    const task = {
      signal: controller.signal,
      progress: (data) => {
        if (!sender.isDestroyed()) sender.send("myfile:progress", { id, data });
      },
    };
    try {
      return await invoke(handlers, name, payload, task);
    } finally {
      running.delete(id);
    }
  });

  ipcMain.handle("myfile:cancel", (event, id) => {
    if (!fromUs(event)) return false;
    const c = running.get(id);
    if (c) c.abort();
    return Boolean(c);
  });

  ipcMain.handle("myfile:dialog", async (event, opts = {}) => {
    if (!fromUs(event)) return null;
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (opts.mode === "save") {
      const res = await dialog.showSaveDialog(parent, {
        title: opts.title,
        defaultPath: opts.defaultPath,
        filters: opts.filters,
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      return res.canceled ? null : res.filePath;
    }
    const props = [];
    if (opts.kind === "folder") props.push("openDirectory", "createDirectory");
    else if (opts.kind === "any") props.push("openFile", "openDirectory");
    else props.push("openFile");
    if (opts.multiple) props.push("multiSelections");
    const res = await dialog.showOpenDialog(parent, {
      title: opts.title,
      buttonLabel: opts.buttonLabel,
      defaultPath: opts.defaultPath,
      filters: opts.filters,
      properties: props,
    });
    return res.canceled ? null : res.filePaths;
  });

  ipcMain.handle("myfile:shell", async (event, { action, target }) => {
    if (!fromUs(event)) return false;
    if (action === "reveal") shell.showItemInFolder(target);
    else if (action === "open") return (await shell.openPath(target)) === "";
    else if (action === "external" && /^https:\/\//.test(target)) await shell.openExternal(target);
    return true;
  });

  ipcMain.handle("myfile:theme", (event, theme) => {
    if (!fromUs(event)) return null;
    nativeTheme.themeSource = ["light", "dark"].includes(theme) ? theme : "system";
    if (win && !IS_MAC) win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#16181d" : "#f4f5f8");
    return nativeTheme.themeSource;
  });

  // -------------------------------------------------------------------------
  // Window
  // -------------------------------------------------------------------------
  const boundsFile = path.join(runtime.dataDir, "window.json");

  function savedBounds() {
    const b = readJson(boundsFile, null);
    if (!b || !Number.isFinite(b.width)) return null;
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x < a.x + a.width - 100 && b.x + b.width > a.x + 100 && b.y >= a.y - 10 && b.y < a.y + a.height - 100;
    });
    return visible ? b : null;
  }

  function createWindow() {
    const theme = ctx.settings.get().theme;
    nativeTheme.themeSource = ["light", "dark"].includes(theme) ? theme : "system";
    const bounds = savedBounds();
    win = new BrowserWindow({
      width: bounds ? bounds.width : 1320,
      height: bounds ? bounds.height : 860,
      x: bounds ? bounds.x : undefined,
      y: bounds ? bounds.y : undefined,
      minWidth: 1000,
      minHeight: 660,
      title: "myFile",
      show: false,
      icon: IS_MAC ? undefined : ICON_PNG,
      titleBarStyle: IS_MAC ? "hiddenInset" : "default",
      trafficLightPosition: { x: 20, y: 20 },
      vibrancy: IS_MAC ? "sidebar" : undefined,
      visualEffectState: "followWindow",
      backgroundColor: IS_MAC ? "#00000000" : nativeTheme.shouldUseDarkColors ? "#16181d" : "#f4f5f8",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        devTools: DEV,
      },
    });
    if (bounds && bounds.maximized) win.maximize();
    win.once("ready-to-show", () => win.show());
    win.on("close", () => {
      try {
        writeJson(boundsFile, { ...win.getNormalBounds(), maximized: win.isMaximized() });
      } catch {
        // not important
      }
    });
    win.on("closed", () => {
      win = null;
    });
    win.loadFile(RENDERER);
  }

  function send(action, extra = {}) {
    if (!win) createWindow();
    const target = win;
    const deliver = () => target.webContents.send("myfile:menu", { action, ...extra });
    if (target.webContents.isLoading()) target.webContents.once("did-finish-load", deliver);
    else deliver();
    target.show();
  }

  // -------------------------------------------------------------------------
  // Menu
  // -------------------------------------------------------------------------
  function buildMenu() {
    const nav = (label, view, accelerator) => ({ label, accelerator, click: () => send("navigate", { view }) });
    const template = [
      ...(IS_MAC
        ? [
            {
              label: "myFile",
              submenu: [
                { role: "about", label: "About myFile" },
                { type: "separator" },
                { label: "Settings…", accelerator: "Cmd+,", click: () => send("navigate", { view: "settings" }) },
                { type: "separator" },
                { role: "services" },
                { type: "separator" },
                { role: "hide", label: "Hide myFile" },
                { role: "hideOthers" },
                { role: "unhide" },
                { type: "separator" },
                { role: "quit", label: "Quit myFile" },
              ],
            },
          ]
        : []),
      {
        label: "File",
        submenu: [
          { label: "Inspect a Photo or Video…", accelerator: "CmdOrCtrl+O", click: () => send("open-inspect") },
          { type: "separator" },
          IS_MAC ? { role: "close" } : { role: "quit" },
        ],
      },
      { role: "editMenu" },
      {
        label: "Go",
        submenu: [
          nav("Overview", "home", "CmdOrCtrl+0"),
          { type: "separator" },
          nav("EXIF · Show", "exif-show", "CmdOrCtrl+1"),
          nav("EXIF · Modify", "exif-modify", "CmdOrCtrl+2"),
          { type: "separator" },
          nav("Folder · Compare", "folder-compare", "CmdOrCtrl+3"),
          nav("Folder · Modify", "folder-modify", "CmdOrCtrl+4"),
          nav("Folder · Generate HTML", "folder-html", "CmdOrCtrl+5"),
          { type: "separator" },
          nav("FileSync", "filesync", "CmdOrCtrl+6"),
          nav("History", "history", "CmdOrCtrl+7"),
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "togglefullscreen" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          ...(DEV ? [{ type: "separator" }, { role: "reload" }, { role: "toggleDevTools" }] : []),
        ],
      },
      { role: "windowMenu" },
      {
        role: "help",
        submenu: [
          { label: "myFile on GitHub", click: () => shell.openExternal("https://github.com/zhengzihao2002/myFile") },
          { label: "Show myFile's Data Folder", click: () => shell.openPath(runtime.dataDir) },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  app.setAboutPanelOptions({
    applicationName: "myFile",
    applicationVersion: VERSION,
    version: `Electron ${process.versions.electron}`,
    credits: "EXIF, folder and sync tools. Built on this Mac from source; everything it uses stays in its own folder.",
    iconPath: ICON_PNG,
  });

  app.on("second-instance", () => {
    if (!win) return createWindow();
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    if (IS_MAC && !app.isPackaged && app.dock && fs.existsSync(ICON_PNG)) app.dock.setIcon(ICON_PNG);
    buildMenu();
    createWindow();
    app.on("activate", () => {
      if (!win) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (!IS_MAC) app.quit();
  });

  app.on("before-quit", () => {
    for (const c of running.values()) c.abort();
  });

  app.on("will-quit", () => {
    et.close();
    for (const dir of [runtime.tmpDir, runtime.previewDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    // Remove macOS's own records of this run once we've exited (and the
    // temporary data folder, when running outside the project folder).
    if (app.isPackaged) janitor.sweepAfterExit(runtime.bundleId, runtime.ephemeral ? [runtime.dataDir] : []);
    else if (runtime.ephemeral) janitor.sweepAfterExit("", [runtime.dataDir]);
  });
}

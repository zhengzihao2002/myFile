"use strict";

// The only bridge between the window and the rest of the app. The page gets
// a small, fixed API on window.myfile; it never sees Node or Electron.

const { contextBridge, ipcRenderer, webUtils } = require("electron");

const progressListeners = new Map();
let menuListener = null;

ipcRenderer.on("myfile:progress", (_event, { id, data }) => {
  const fn = progressListeners.get(id);
  if (fn) fn(data);
});

ipcRenderer.on("myfile:menu", (_event, message) => {
  if (menuListener) menuListener(message);
});

contextBridge.exposeInMainWorld("myfile", {
  platform: process.platform,

  // Runs a named operation. Resolves to { ok, result } or { ok: false, error }.
  task(id, name, payload, onProgress) {
    if (typeof onProgress === "function") progressListeners.set(id, onProgress);
    return ipcRenderer.invoke("myfile:task", { id, name, payload }).finally(() => progressListeners.delete(id));
  },

  cancel(id) {
    return ipcRenderer.invoke("myfile:cancel", id);
  },

  // Ask a running operation to finish what it is doing and then stop.
  softStop(id) {
    return ipcRenderer.invoke("myfile:softStop", id);
  },

  // The real path of a file or folder dropped onto the window.
  pathForFile(file) {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },

  // { mode: "open"|"save", kind: "file"|"folder"|"any", multiple, title, filters, defaultPath }
  dialog(options) {
    return ipcRenderer.invoke("myfile:dialog", options);
  },

  reveal(target) {
    return ipcRenderer.invoke("myfile:shell", { action: "reveal", target });
  },

  open(target) {
    return ipcRenderer.invoke("myfile:shell", { action: "open", target });
  },

  openExternal(url) {
    return ipcRenderer.invoke("myfile:shell", { action: "external", target: url });
  },

  setTheme(theme) {
    return ipcRenderer.invoke("myfile:theme", theme);
  },

  onMenu(fn) {
    menuListener = typeof fn === "function" ? fn : null;
  },
});

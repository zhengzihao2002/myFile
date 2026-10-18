/* Stand-in for the Electron preload when the UI runs in a browser via the harness. */
(function () {
  "use strict";
  const listeners = new Map();
  const events = new EventSource("/events");
  events.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const fn = listeners.get(msg.id);
    if (fn) fn(msg.data);
  };
  const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

  // Tests push answers here: an array of paths for open dialogs, a path for save dialogs.
  window.__dialogQueue = [];
  let menu = null;
  window.__menu = (msg) => menu && menu(msg);

  window.myfileHarness = {
    platform: new URLSearchParams(location.search).get("platform") || "darwin",
    task(id, name, payload, onProgress) {
      if (onProgress) listeners.set(id, onProgress);
      return post("/task", { id, name, payload }).finally(() => listeners.delete(id));
    },
    cancel: (id) => post("/cancel", { id }),
    softStop: (id) => post("/softStop", { id }),
    pathForFile: (file) => file.path || "",
    dialog(opts) {
      if (window.__dialogQueue.length) return Promise.resolve(window.__dialogQueue.shift());
      const answer = window.prompt(`${opts.title || "Path"} (harness: type a path)`);
      if (!answer) return Promise.resolve(null);
      return Promise.resolve(opts.mode === "save" ? answer : answer.split("\n"));
    },
    reveal: (target) => post("/shell", { action: "reveal", target }),
    open: (target) => post("/shell", { action: "open", target }),
    openExternal: (target) => post("/shell", { action: "external", target }),
    setTheme: () => Promise.resolve(),
    onMenu: (fn) => (menu = fn),
  };
  document.addEventListener("DOMContentLoaded", () => document.body.classList.add("no-vibrancy"));
})();

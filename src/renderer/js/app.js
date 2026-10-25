/* myFile app shell: sidebar, routing, theme. */
(function () {
  "use strict";

  const { h, icon, api, replace } = MF;

  const NAV = [
    { items: [{ id: "home", label: "Overview", icon: "home", key: "0" }] },
    {
      label: "EXIF",
      items: [
        { id: "exif-show", label: "Show", icon: "photo", key: "1" },
        { id: "exif-modify", label: "Modify", icon: "wand", key: "2" },
        { id: "exif-batch", label: "Batch Modify", icon: "layers", key: "8" },
      ],
    },
    {
      label: "Folder",
      items: [
        { id: "folder-compare", label: "Compare", icon: "compare", key: "3" },
        { id: "folder-modify", label: "Modify", icon: "clockfix", key: "4" },
        { id: "folder-html", label: "Generate HTML", icon: "html", key: "5" },
      ],
    },
    { label: "FileSync", items: [{ id: "filesync", label: "Sync & Clone", icon: "sync", key: "6" }] },
  ];
  const FOOT = [
    { id: "history", label: "History", icon: "history", key: "7" },
    { id: "settings", label: "Settings", icon: "settings", key: "," },
  ];

  const mounted = new Map();
  let current = null;
  const navButtons = new Map();

  const header = {
    title: h("h1"),
    sub: h("p"),
    actions: h("div.actions"),
  };
  const content = h("div.content");

  function navItem(item) {
    const b = h(
      "button.nav-item",
      { type: "button", on: { click: () => MF.go(item.id) } },
      icon(item.icon),
      h("span", item.label),
      item.key ? h("span.kbd", `⌘${item.key}`) : null,
    );
    navButtons.set(item.id, b);
    return b;
  }

  function buildShell() {
    const sidebar = h(
      "aside.sidebar",
      h("div.brand", h("img", { src: "../../assets/icon.png", alt: "", on: { error: (e) => (e.target.style.visibility = "hidden") } }), h("div", h("div.name", "myFile"), h("div.tag", "EXIF · Folders · Sync"))),
      h(
        "nav.nav",
        NAV.map((group) => h("div.nav-group", group.label ? h("div.nav-label", group.label) : null, group.items.map(navItem))),
      ),
      h(
        "div.sidebar-foot",
        FOOT.map(navItem),
        h("div.storage-note", { title: "Everything myFile downloads or saves stays in its own folder." }, icon("leaf"), h("span", "Self-contained: delete the myFile folder and nothing is left behind.")),
      ),
    );
    const main = h("main.main", h("header.header", h("div.titles", header.title, header.sub), header.actions), content);
    document.body.appendChild(h("div.app", sidebar, main));
  }

  // Screens that hold work on screen get a Clear button; Overview, History and Settings don't.
  const NO_CLEAR = new Set(["home", "history", "settings"]);

  /** The header buttons for a screen: its own, then Clear. */
  function headerActions(id, instance) {
    const own = instance.actions ? instance.actions() : null;
    if (NO_CLEAR.has(id)) return own;
    return [own, MF.Button("Clear", { size: "sm", iconName: "x", title: "Clear this screen, as if myFile had just been opened", onClick: () => MF.clearView(id) })];
  }

  /**
   * Throws away everything a screen is showing (files, results, choices) and
   * builds it again, as if the app had just started. Other screens are left alone.
   */
  MF.clearView = function clearView(id) {
    const old = mounted.get(id);
    if (old && old.onHide) old.onHide();
    mounted.delete(id);
    MF.go(id);
  };

  MF.go = function go(id, params) {
    const view = MF.views[id];
    if (!view) return;
    if (current && current.id !== id && current.instance.onHide) current.instance.onHide();
    let instance = mounted.get(id);
    if (!instance) {
      instance = view.mount();
      mounted.set(id, instance);
    }
    current = { id, instance };
    for (const [vid, b] of navButtons) b.classList.toggle("active", vid === id);
    replace(header.title, view.crumb ? h("span.crumb", `${view.crumb} ›`) : null, view.title);
    header.sub.textContent = view.subtitle || "";
    replace(header.actions, headerActions(id, instance));
    const wrap = h(`div.view${view.full ? ".full" : ""}`, instance.el);
    replace(content, wrap);
    content.scrollTop = 0;
    if (instance.onShow) instance.onShow(params || {});
    try {
      localStorage.setItem("myfile.view", id);
    } catch {
      // storage unavailable
    }
  };

  MF.refreshHeader = function refreshHeader() {
    if (!current) return;
    replace(header.actions, headerActions(current.id, current.instance));
  };

  // ---------------------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------------------

  const media = window.matchMedia("(prefers-color-scheme: dark)");
  let themeChoice = "system";
  function applyTheme() {
    const dark = themeChoice === "dark" || (themeChoice === "system" && media.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }
  media.addEventListener("change", applyTheme);
  MF.setTheme = function setTheme(choice) {
    themeChoice = choice || "system";
    applyTheme();
    api.setTheme(themeChoice);
  };

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  document.addEventListener("DOMContentLoaded", async () => {
    if (!window.myfile && !window.myfileHarness) return;
    document.body.classList.add(`platform-${api.platform}`);
    // Dropping a file anywhere else must never navigate the window away.
    document.addEventListener("dragover", (e) => e.preventDefault());
    document.addEventListener("drop", (e) => e.preventDefault());
    buildShell();
    try {
      MF.settings = await api.run("settings.get");
    } catch {
      MF.settings = { theme: "system" };
    }
    MF.setTheme(MF.settings.theme);
    api.onMenu((msg) => {
      if (msg.action === "navigate") MF.go(msg.view);
      if (msg.action === "open-inspect") MF.go("exif-show", { browse: true });
    });
    let start = "home";
    try {
      const saved = localStorage.getItem("myfile.view");
      if (saved && MF.views[saved]) start = saved;
    } catch {
      // storage unavailable
    }
    MF.go(start);
  });
})();

/* Overview */
(function () {
  "use strict";

  const { h, icon, fmt, api, replace } = MF;

  const HISTORY_ICONS = {
    "exif-copy": "wand",
    "exif-dates": "calendar",
    "folder-modify": "clockfix",
    filesync: "sync",
  };

  MF.historyIcon = (type) => HISTORY_ICONS[type] || "history";

  function feature(color, iconName, title, text, links) {
    return h(
      "div.feature",
      h("div.fi", { style: { background: color } }, icon(iconName)),
      h("h3", title),
      h("p", text),
      h(
        "div.links",
        links.map(([label, linkIcon, view, params]) =>
          h("button.link", { type: "button", on: { click: () => MF.go(view, params) } }, icon(linkIcon), h("span", label), h("span.go", icon("arrow"))),
        ),
      ),
    );
  }

  MF.views.home = {
    title: "Overview",
    subtitle: "Photo metadata, folder dates and exact clones, all on this Mac.",
    mount() {
      const recent = h("div.card");
      const storage = h("div.card.card-pad");

      const el = h(
        "div.stack",
        h(
          "div.hero",
          h("img", { src: "../../assets/icon.png", alt: "" }),
          h("div", h("h2", "Welcome to myFile"), h("p", "Inspect and fix the dates and locations inside photos and videos, line folders up with each other, and keep exact clones on other drives.")),
          h(
            "div.hero-actions",
            h("button.btn", { on: { click: () => MF.go("exif-show", { browse: true }) } }, icon("photo"), "Inspect a photo"),
            h("button.btn", { on: { click: () => MF.go("filesync") } }, icon("sync"), "Start a sync"),
          ),
        ),
        h(
          "div.grid3",
          feature("linear-gradient(135deg,#ff9f5a,#ff6a5c)", "photo", "EXIF", "See everything a photo or video knows about itself, copy dates and places between files, or set file dates from EXIF.", [
            ["Show metadata", "eye", "exif-show"],
            ["Copy from a reference file", "wand", "exif-modify", { mode: "copy" }],
            ["Set file dates from EXIF", "calendar", "exif-modify", { mode: "self" }],
            ["Fix a whole folder, file by file", "layers", "exif-batch", {}],
          ]),
          feature("linear-gradient(135deg,#55a0ff,#3a62f0)", "folder", "Folder", "Compare two folders, restore every date in a copy from its original, and save a folder index as an elegant HTML page.", [
            ["Compare two folders", "compare", "folder-compare"],
            ["Fix dates from a reference", "clockfix", "folder-modify"],
            ["Generate an HTML index", "html", "folder-html"],
          ]),
          feature("linear-gradient(135deg,#2fd197,#0c9f8f)", "sync", "FileSync", "Make other folders or drives exact clones of a reference, down to EXIF and dates, or split one big folder across several drives.", [
            ["Direct clone", "clone", "filesync", { mode: "direct" }],
            ["Split across drives", "split", "filesync", { mode: "split" }],
          ]),
        ),
        MF.Section("Recent activity", "Undo date and EXIF changes from History", h("button.btn.sm", { on: { click: () => MF.go("history") } }, "Open History")),
        recent,
        MF.Section("Where myFile keeps things"),
        storage,
      );

      async function refresh() {
        try {
          const [list, info, usage] = await Promise.all([api.run("history.list"), api.run("app.info"), api.run("data.usage")]);
          replace(
            recent,
            list.length
              ? h(
                  "div.history-list",
                  list.slice(0, 5).map((e) =>
                    h("div.hrow", h("div.hi", icon(MF.historyIcon(e.type))), h("div.ht", h("div.a", e.title), h("div.b", e.summary)), e.reverted ? h("span.badge", "Undone") : null, h("div.when", fmt.ago(e.at))),
                  ),
                )
              : MF.Empty({ iconName: "history", title: "Nothing yet", text: "Changes you make show up here, with Undo for dates and EXIF." }),
          );
          replace(
            storage,
            h(
              "div.row",
              { style: { alignItems: "flex-start" } },
              h("div", { style: { flex: "1", minWidth: "0" } },
                h("div", { style: { fontWeight: "650", marginBottom: "4px" } }, info.ephemeral ? "Temporary mode" : "Everything stays in the myFile folder"),
                h(
                  "div.muted.small",
                  info.ephemeral
                    ? "myFile.app was moved out of its project folder, so its settings and history live in a temporary folder that is removed when you quit."
                    : "Node, Electron, ExifTool, settings and history all live inside the project folder. Each time myFile quits it also clears the notes macOS keeps about apps (window state, preferences). Delete the folder and nothing is left.",
                ),
                h("div.small.mono.faint.selectable", { style: { marginTop: "8px" } }, info.dataDir),
              ),
              h("div", { style: { textAlign: "right" } }, h("div", { style: { fontSize: "20px", fontWeight: "700" } }, fmt.size(usage.bytes)), h("div.muted.small", "app data")),
              h("button.btn.sm", { on: { click: () => api.reveal(info.dataDir) } }, icon("reveal"), "Show"),
            ),
          );
        } catch (err) {
          MF.fail(err);
        }
      }

      return { el, onShow: refresh };
    },
  };
})();

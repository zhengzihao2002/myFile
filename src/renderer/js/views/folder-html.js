/* Folder › Generate HTML */
(function () {
  "use strict";

  const { h, icon, fmt, api, replace } = MF;

  MF.views["folder-html"] = {
    crumb: "Folder",
    title: "Generate HTML",
    subtitle: "Save a folder's whole tree, with every date, as one elegant web page. It doubles as a reference for Folder › Modify.",
    mount() {
      const options = { exif: true, includeAll: false };
      const out = h("div.stack");

      const drop = MF.DropZone({ label: "Folder", accept: "folder", title: "Drop the folder to index", subtitle: "Everything inside it, however deep, is listed", glyph: "html", onChange: () => { replace(out); genBtn.disabled = !drop.paths.length; } });
      const exifOpt = MF.Option({ title: "Include EXIF dates", desc: "Reads the date inside every photo and video (slower). Lets Modify restore EXIF dates from this page later.", checked: options.exif, onChange: (v) => (options.exif = v) });
      const sysOpt = MF.Option({ title: "Include system files", desc: ".DS_Store, Thumbs.db and similar.", checked: options.includeAll, onChange: (v) => (options.includeAll = v) });
      const genBtn = MF.Button("Generate…", { kind: "primary", size: "lg", iconName: "html", disabled: true, onClick: generate });

      const preview = h(
        "div.card.card-pad",
        h("div.row", { style: { alignItems: "flex-start", gap: "18px" } },
          h("div", { style: { width: "54px", height: "54px", borderRadius: "14px", display: "grid", placeItems: "center", background: "var(--amber-soft)", color: "var(--amber)", flex: "none" } }, icon("html")),
          h("div", { style: { flex: "1" } },
            h("div", { style: { fontWeight: "650", marginBottom: "4px" } }, "What you get"),
            h("ul.muted.small", { style: { margin: "0", paddingLeft: "18px", lineHeight: "1.7" } },
              h("li", "A collapsible tree with created, modified and EXIF “taken” dates for every item."),
              h("li", "Search, sorting, and the oldest and newest items at a glance."),
              h("li", "One self-contained file that opens in any browser, light or dark."),
              h("li", "Drop it into Folder › Modify as the reference to put these dates back on a copy."),
            ),
          ),
        ),
      );

      const el = h(
        "div.stack",
        drop.el,
        h("div.card.card-pad", { style: { paddingTop: "6px", paddingBottom: "6px" } }, exifOpt.el, sysOpt.el),
        h("div.row", h("span.spacer"), genBtn),
        out,
        preview,
      );

      async function generate() {
        const folder = drop.paths[0];
        const name = `${fmt.base(folder)} — index.html`;
        const output = await api.dialog({ mode: "save", title: "Save the HTML index", defaultPath: `${fmt.dir(folder)}/${name}`, filters: [{ name: "Web page", extensions: ["html"] }] });
        if (!output) return;
        try {
          const res = await MF.busy("Indexing…", "folder.index", { folder, output, options }, (p) => {
            if (p.phase === "scan") return { label: "Reading the folder…", left: `${fmt.num(p.scanned)} items` };
            if (p.phase === "exif") return { label: "Reading EXIF dates…", ratio: p.total ? p.done / p.total : null, left: `${fmt.num(p.done)} of ${fmt.num(p.total)} photos and videos` };
            return {};
          });
          const s = res.stats;
          replace(
            out,
            h(
              "div.verdict.good",
              h("div.big-icon", icon("check")),
              h("div", h("h3", fmt.base(res.output)), h("p", `${fmt.plural(s.files, "file")} · ${fmt.plural(s.dirs, "folder")} · ${fmt.size(s.size)} indexed${options.exif ? ` · ${fmt.num(s.withExif)} with EXIF dates` : ""} · page is ${res.sizeText}`)),
              h(
                "div.actions",
                MF.Button("Open", { iconName: "external", onClick: () => api.open(res.output) }),
                MF.Button("Reveal", { iconName: "reveal", onClick: () => api.reveal(res.output) }),
                MF.Button("Use as reference", { iconName: "clockfix", onClick: () => MF.go("folder-modify", { reference: res.output }) }),
              ),
            ),
            res.insideFolder ? MF.Callout("amber", h("b", "Saved inside the indexed folder. "), "That's fine, but the page itself isn't listed in it, and Folder › Modify will ignore it when it checks this folder.") : null,
            s.errorCount ? MF.Callout("amber", h("b", `${fmt.plural(s.errorCount, "item")} couldn't be read. `), s.errors.slice(0, 3).join(" · ")) : null,
          );
          MF.toast("HTML index saved", { kind: "success", action: { label: "Open", run: () => api.open(res.output) } });
        } catch (err) {
          MF.fail(err);
        }
      }

      return {
        el,
        onShow(params) {
          if (params.folder) drop.set([params.folder]);
        },
      };
    },
  };
})();

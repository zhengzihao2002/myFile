/* Settings */
(function () {
  "use strict";

  const { h, fmt, api, replace } = MF;

  MF.views.settings = {
    title: "Settings",
    subtitle: "Preferences are saved inside the myFile folder.",
    mount() {
      const box = h("div.settings");
      const el = h("div", box);

      async function save(patch) {
        try {
          MF.settings = await api.run("settings.set", patch);
        } catch (err) {
          MF.fail(err);
        }
      }

      async function render() {
        const [s, info, usage] = await Promise.all([api.run("settings.get"), api.run("app.info"), api.run("data.usage")]).catch((err) => {
          MF.fail(err);
          return [];
        });
        if (!s) return;
        const usageText = h("span", fmt.size(usage.bytes));

        const theme = MF.Segmented({
          value: s.theme,
          options: [
            { value: "system", label: "Automatic" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ],
          onChange: (v) => {
            MF.setTheme(v);
            save({ theme: v });
          },
        });
        const tolerance = MF.Segmented({
          value: s.toleranceMs <= 1 ? 1 : s.toleranceMs >= 2000 ? 2000 : 1000,
          options: [
            { value: 1, label: "Exact", title: "Dates must match to the millisecond" },
            { value: 1000, label: "To the second", title: "Recommended. What Finder shows" },
            { value: 2000, label: "Within 2 seconds", title: "For FAT32 drives, which store times in 2-second steps" },
          ],
          onChange: (v) => save({ toleranceMs: v }),
        });
        const compare = MF.Segmented({
          value: s.compareContent,
          options: [
            { value: "smart", label: "Smart · recommended", title: "Same size and date = identical; same size but different date = read both" },
            { value: "thorough", label: "Every byte · strictest", title: "Read and compare every pair of same-size files" },
            { value: "size", label: "Size only · fastest", title: "Same size = identical; nothing is read" },
          ],
          onChange: (v) => save({ compareContent: v }),
        });
        const includeAll = MF.Option({ title: "Include system files", desc: ".DS_Store, ._ files, Thumbs.db and other operating-system bookkeeping. Off by default everywhere.", checked: s.includeAll, onChange: (v) => save({ includeAll: v }) });

        const line = (k, v) => h("div.kvline", h("span.k", k), h("span.v.selectable", v));
        replace(
          box,
          h(
            "div.card.card-pad.group-card",
            h("h3", "Appearance"),
            h("div.option", h("span.text", h("div.title", "Theme"), h("div.desc", "Automatic follows macOS.")), theme.el),
          ),
          h(
            "div.card.card-pad.group-card",
            h("h3", "Comparing"),
            h("div.option", h("span.text", h("div.title", "When are two dates the same?"), h("div.desc", "Used to decide what needs fixing. New dates are always written exactly.")), tolerance.el),
            h("div.option", h("span.text", h("div.title", "Folder › Compare checks contents by"), h("div.desc", "Smart reads files only when size matches but dates differ.")), compare.el),
            includeAll.el,
          ),
          h(
            "div.card.card-pad.group-card",
            h("h3", "Storage"),
            h("p.muted.small", { style: { margin: "4px 0 10px" } }, info.ephemeral
              ? "myFile.app is running outside its project folder, so it uses a temporary data folder that is deleted when you quit."
              : "Everything myFile saves (settings, history, previews) is in its own folder. Each time it quits, it also removes what macOS records about apps it has run. Deleting the myFile folder removes everything."),
            line("Data folder", info.dataDir),
            line("Using", usageText),
            h(
              "div.row",
              { style: { marginTop: "10px" } },
              MF.Button("Show in Finder", { size: "sm", iconName: "reveal", onClick: () => api.reveal(info.dataDir) }),
              MF.Button("Clear previews", {
                size: "sm",
                iconName: "trash",
                onClick: async () => {
                  const res = await api.run("data.clearPreviews").catch(MF.fail);
                  if (res) usageText.textContent = fmt.size(res.bytes);
                },
              }),
            ),
          ),
          h(
            "div.card.card-pad.group-card",
            h("h3", "About"),
            line("myFile", info.version),
            line("ExifTool", info.exiftoolVersion || "not found"),
            line("Perl", info.perl),
            line("Electron", info.versions.electron || "—"),
            line("Node.js", info.versions.node),
            line("Setting created dates", info.canSetCreationDate ? "Supported (via macOS Foundation)" : "Not supported on this system"),
            h(
              "div.row",
              { style: { marginTop: "10px" } },
              MF.Button("myFile on GitHub", { size: "sm", iconName: "external", onClick: () => api.openExternal("https://github.com/zhengzihao2002/myFile") }),
            ),
          ),
          info.exiftoolVersion ? null : MF.Callout("red", h("b", "ExifTool isn't available. "), "Run bash install.sh again to restore it."),
        );
      }

      return { el, onShow: render };
    },
  };
})();

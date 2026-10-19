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
        const parallel = MF.Segmented({
          value: String(s.parallelFiles || "auto"),
          options: [
            { value: "auto", label: "Automatic", title: "4 for SSDs, 1 for spinning hard disks, 2 otherwise" },
            { value: "1", label: "1", title: "One file at a time. Best for slow USB drives and hard disks" },
            { value: "2", label: "2" },
            { value: "4", label: "4" },
            { value: "8", label: "8", title: "For fast SSDs and many small files" },
          ],
          onChange: (v) => save({ parallelFiles: v === "auto" ? "auto" : Number(v) }),
        });

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
            h("h3", "Performance"),
            h("div.option", h("span.text", h("div.title", "Files at the same time"), h("div.desc", "How many files are compared, analyzed or copied together. Automatic picks 4 for SSDs, 1 for spinning hard disks and 2 otherwise. A slow USB drive is often faster with 1 or 2; a fast SSD with 4 or more. The progress window lists every file in progress.")), parallel.el),
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

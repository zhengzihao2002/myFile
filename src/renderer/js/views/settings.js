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

        // Folder Compare › Custom: which facts must match. The other three modes are shown as a fixed reference.
        const custom = { size: true, modified: true, created: false, exifDates: true, gps: true, otherMeta: false, contents: false, ...s.customCompare };
        const MATRIX = [
          { key: "size", label: "Size", ref: ["yes", "yes", "yes"] },
          { key: "modified", label: "Modified date", ref: ["Dates match: file not read", "no", "no"] },
          { key: "created", label: "Created date", ref: ["no", "no", "no"] },
          { key: "exifDates", label: "Photo / video dates (EXIF)", ref: ["Read in full only if the modified date differs", "yes", "no"], inContents: true },
          { key: "gps", label: "GPS location", ref: ["Read in full only if the modified date differs", "yes", "no"], inContents: true },
          { key: "otherMeta", label: "Other metadata (camera, etc.)", ref: ["Read in full only if the modified date differs", "yes", "no"], inContents: true },
          { key: "contents", label: "Every byte of the contents", ref: ["Read in full only if the modified date differs", "yes", "no"] },
        ];
        const refCell = (v) => h("div.cm-ref" + (v === "no" ? ".no" : ""), v === "yes" ? "✓" : v === "no" ? "–" : v);
        const matrix = h("div.cm-grid");
        const matrixNote = h("p.muted.small", { style: { margin: "10px 0 0" } }, h("b", "Smart: "), "if a file’s size and modified date match, it counts as identical and is not read. Only when the modified date differs is the file read in full, which compares its contents, EXIF, GPS and all other metadata.");
        const drawMatrix = () => {
          const head = h("div.cm-row.cm-headrow", ...["", "Smart", "Every byte", "Size only", "Custom"].map((t, i) => h("div.cm-head" + (i === 4 ? ".custom" : ""), t)));
          const rows = MATRIX.flatMap((m) => {
            const implied = m.inContents && custom.contents;
            const sw = h("input", { type: "checkbox", checked: implied || Boolean(custom[m.key]), disabled: implied, on: { change: () => { custom[m.key] = sw.checked; save({ customCompare: { ...custom } }); drawMatrix(); } } });
            return [
              h(
                "div.cm-row",
                h("div.cm-label", m.label, implied ? h("span.cm-sub", "included in every byte") : null),
                ...m.ref.map(refCell),
                h("label.cm-custom", h("span.switch", sw, h("span.track"), h("span.thumb"))),
              ),
            ];
          });
          replace(matrix, head, ...rows);
        };
        drawMatrix();

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
            h("h3", "Comparing and speed"),
            h("div.option", h("span.text", h("div.title", "When are two dates the same?"), h("div.desc", "Used by Folder Compare, Folder Modify, Sync and EXIF to decide what needs fixing. Drives with coarser clocks (exFAT, FAT32) are allowed for automatically. New dates are always written exactly.")), tolerance.el),
            h("div.option", h("span.text", h("div.title", "Files at the same time"), h("div.desc", "How many files are compared, analyzed or copied together. Automatic picks 4 for SSDs, 1 for spinning hard disks and 2 otherwise. A slow USB drive is often faster with 1 or 2; a fast SSD with 4 or more. The progress window lists every file in progress.")), parallel.el),
          ),
          h(
            "div.card.card-pad.group-card",
            h("h3", "What counts as identical (Folder Compare and Sync)"),
            h("p.muted.small", { style: { margin: "4px 0 10px" } }, "Pick Custom in Folder Compare or Sync to use the switches in the last column; two files at the same path are identical only if everything switched on matches. The other three columns just show what the built-in modes check. Reading every byte is what catches edits to anything inside a file, so with it on the metadata rows are covered automatically. Without it, files are not read in full: photo and video info is read from the file header only, which is much faster."),
            matrix,
            matrixNote,
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

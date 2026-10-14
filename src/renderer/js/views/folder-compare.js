/* Folder › Compare */
(function () {
  "use strict";

  const { h, icon, fmt, api, replace } = MF;

  const REASONS = { size: "Size differs", content: "Contents differ", type: "File vs folder", link: "Link target", unreadable: "Unreadable" };
  const CHECKS = { bytes: "Byte-by-byte", quick: "Size + date", size: "Size only", link: "Link" };

  MF.views["folder-compare"] = {
    crumb: "Folder",
    title: "Compare",
    subtitle: "What's only on one side, what changed, and what's identical. Nothing is modified.",
    mount() {
      let result = null;
      const settings = MF.settings || {};
      let content = settings.compareContent || "smart";
      let includeAll = Boolean(settings.includeAll);

      const dropA = MF.DropZone({ label: "Folder A", step: "A", accept: "folder", title: "Drop the first folder", subtitle: "Usually the original", glyph: "folder", onChange: changed });
      const dropB = MF.DropZone({ label: "Folder B", step: "B", accept: "folder", title: "Drop the second folder", subtitle: "Usually the copy", glyph: "folder", onChange: changed });
      const swap = h(
        "button.btn.icon",
        {
          title: "Swap A and B",
          style: { alignSelf: "center", marginTop: "40px", borderRadius: "50%" },
          on: {
            click: () => {
              const a = dropA.paths;
              const b = dropB.paths;
              dropA.set(b);
              dropB.set(a);
            },
          },
        },
        icon("swap"),
      );
      // What each content check does, shown under the choice.
      // EXIF dates, GPS and every other tag live inside the file's bytes, so
      // only reading the bytes catches every edit. Created/modified dates are
      // file-system data and are compared in every mode ("Different dates").
      const MODES = {
        smart: { label: "Smart", hint: "recommended", text: [h("b", "Same size and same modified date"), " count as identical without reading them; if only the date differs, both files are read. Misses an edit inside a file (EXIF date, GPS) only if the size and modified date stayed the same."] },
        thorough: { label: "Every byte", hint: "strictest", text: [h("b", "Reads and compares every pair of same-size files."), " Catches any difference inside the files, including EXIF dates and GPS. Slowest on big folders."] },
        size: { label: "Size only", hint: "fastest", text: [h("b", "Same size counts as identical"), "; nothing is read. Fastest, but most EXIF or GPS edits keep the size, so they're missed."] },
      };
      const datesNote = h("div.mode-help", { style: { marginTop: "4px" } }, icon("calendar"), h("span", "Created and modified dates are compared in every mode and listed under ", h("b", "Different dates"), "."));
      const modeHelp = h("div.mode-help");
      const showHelp = (v) => replace(modeHelp, icon("info"), h("span", ...MODES[v].text));
      const modeSeg = MF.Segmented({
        value: content,
        options: Object.entries(MODES).map(([value, m]) => ({ value, label: `${m.label} · ${m.hint}` })),
        onChange: (v) => {
          content = v;
          showHelp(v);
        },
      });
      showHelp(content);
      const sysOpt = MF.Option({ title: "Include system files", desc: ".DS_Store, Thumbs.db and similar", checked: includeAll, onChange: (v) => (includeAll = v) });
      sysOpt.el.style.maxWidth = "320px";
      const runBtn = MF.Button("Compare", { kind: "primary", size: "lg", iconName: "compare", disabled: true, onClick: run });
      const out = h("div.stack");

      const el = h(
        "div.stack",
        h("div", { style: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 1fr)", gap: "12px", alignItems: "start" } }, dropA.el, swap, dropB.el),
        h(
          "div.card.card-pad",
          h(
            "div.row",
            { style: { flexWrap: "wrap", gap: "18px" } },
            h("div", h("div", { style: { fontWeight: "650", marginBottom: "6px" } }, "How to decide two files are the same"), modeSeg.el, modeHelp, datesNote),
            h("div", { style: { flex: "1", minWidth: "220px" } }, sysOpt.el),
            runBtn,
          ),
        ),
        out,
      );

      function changed() {
        runBtn.disabled = !(dropA.paths.length && dropB.paths.length);
      }

      async function run() {
        try {
          result = await MF.busy("Comparing folders…", "folder.compare", { a: dropA.paths[0], b: dropB.paths[0], options: { content, includeAll } }, (p) => {
            if (p.phase === "scan") return { label: "Reading both folders…", left: `A: ${fmt.num(p.scannedA)} items`, right: `B: ${fmt.num(p.scannedB)} items` };
            if (p.phase === "content") return { label: "Comparing file contents…", ratio: p.totalBytes ? p.doneBytes / p.totalBytes : null, left: `${fmt.size(p.doneBytes)} of ${fmt.size(p.totalBytes)}`, right: `${fmt.num(p.doneFiles)} of ${fmt.num(p.totalFiles)} files`, current: p.current };
            return {};
          });
          render();
        } catch (err) {
          MF.fail(err);
        }
      }

      async function exportReport() {
        const name = `${result.a.name} vs ${result.b.name} — comparison.html`;
        const output = await api.dialog({ mode: "save", title: "Save the comparison report", defaultPath: `${fmt.dir(result.a.root)}/${name}`, filters: [{ name: "Web page", extensions: ["html"] }] });
        if (!output) return;
        try {
          const res = await api.run("folder.compareExport", { id: result.id, output });
          MF.toast("Report saved", { kind: "success", detail: `${fmt.base(res.output)} · ${res.sizeText}`, action: { label: "Open", run: () => api.open(res.output) } });
        } catch (err) {
          MF.fail(err);
        }
      }

      function render() {
        const r = result;
        const c = r.counts;
        const sizeDiff = r.b.size - r.a.size;
        const fileDiff = r.b.files - r.a.files;
        const tone = r.same ? "good" : "warn";
        const verdict = h(
          `div.verdict.${tone}`,
          h("div.big-icon", icon(r.same ? "check" : "compare")),
          h(
            "div",
            h("h3", r.same ? (c.dateDiffs ? "Same contents, some dates differ" : "These folders are identical") : "These folders differ"),
            h("p", `${fmt.plural(c.identical, "identical file")} · ${fmt.num(c.changed)} changed · ${fmt.num(c.onlyA)} only in A · ${fmt.num(c.onlyB)} only in B · ${fmt.duration(r.elapsedMs)}`),
          ),
          h("div.actions", MF.Button("Export HTML report", { iconName: "save", onClick: exportReport }), MF.Button("Compare again", { iconName: "refresh", onClick: run })),
        );
        const stats = h(
          "div.grid4",
          MF.Stat({ label: "Files", iconName: "file", value: `${fmt.num(r.a.files)} → ${fmt.num(r.b.files)}`, sub: fileDiff ? `${fileDiff > 0 ? "+" : ""}${fmt.num(fileDiff)} in B` : "Same count" }),
          MF.Stat({ label: "Total size", iconName: "disk", value: `${fmt.size(r.a.size)} → ${fmt.size(r.b.size)}`, sub: sizeDiff ? `${sizeDiff > 0 ? "+" : ""}${fmt.size(sizeDiff)} in B` : "Same size" }),
          MF.Stat({ label: "Identical", iconName: "check", value: fmt.num(c.identical), sub: c.dateDiffs ? `${fmt.num(c.dateDiffs)} with different dates` : "Same path, same contents", tone: "good" }),
          MF.Stat({ label: "Changed", iconName: "alert", value: fmt.num(c.changed), sub: "Same path, different contents", tone: c.changed ? "warn" : null }),
        );

        const views = {
          onlyA: { rows: r.onlyA, columns: [col.path, col.size("size"), col.date("Modified", "mtimeMs")] },
          onlyB: { rows: r.onlyB, columns: [col.path, col.size("size"), col.date("Modified", "mtimeMs")] },
          changed: {
            rows: r.changed,
            columns: [col.path, col.size("sizeA", "A size"), col.size("sizeB", "B size"), col.date("A modified", "mtimeA"), col.date("B modified", "mtimeB"), { label: "Why", width: "130px", render: (x) => h("span.badge.amber", REASONS[x.reason] || x.reason) }],
          },
          dates: {
            rows: r.dateDiffs,
            columns: [
              col.path,
              { label: "Created (A → B)", width: "minmax(250px, 1.3fr)", render: (x) => (x.diff === "created" || x.diff === "both" ? MF.DateChange(x.birthA, x.birthB) : h("span.faint", "same")) },
              { label: "Modified (A → B)", width: "minmax(250px, 1.3fr)", render: (x) => (x.diff === "modified" || x.diff === "both" ? MF.DateChange(x.mtimeA, x.mtimeB) : h("span.faint", "same")) },
            ],
          },
          identical: { rows: r.identical, columns: [col.path, col.size("size"), col.date("Modified (A)", "mtimeA"), { label: "Checked by", width: "120px", render: (x) => h("span.badge.green", CHECKS[x.check] || x.check) }] },
          foldersA: { rows: r.foldersOnlyA.map((rel) => ({ rel, kind: "dir" })), columns: [col.path] },
          foldersB: { rows: r.foldersOnlyB.map((rel) => ({ rel, kind: "dir" })), columns: [col.path] },
        };
        const tabDefs = [
          { id: "onlyA", label: "Only in A", count: c.onlyA },
          { id: "onlyB", label: "Only in B", count: c.onlyB },
          { id: "changed", label: "Changed", count: c.changed },
          { id: "dates", label: "Different dates", count: c.dateDiffs },
          { id: "identical", label: "Identical", count: c.identical },
          { id: "foldersA", label: "Folders only in A", count: c.foldersOnlyA },
          { id: "foldersB", label: "Folders only in B", count: c.foldersOnlyB },
        ];
        const first = (tabDefs.find((t) => t.count && t.id !== "identical") || tabDefs.find((t) => t.count) || tabDefs[0]).id;
        const tableBox = h("div");
        const search = h("input", { placeholder: "Filter by path", spellcheck: false });
        let active = first;
        let table = null;
        const show = (id) => {
          active = id;
          table = MF.VirtualTable({ columns: views[id].columns, rows: views[id].rows, maxHeight: 460, empty: "Nothing here." });
          replace(tableBox, table.el);
          applyFilter();
        };
        const applyFilter = () => {
          const term = search.value.trim().toLowerCase();
          table.setFilter(term ? (x) => x.rel.toLowerCase().includes(term) : null);
        };
        search.addEventListener("input", MF.debounce(applyFilter, 120));
        const tabs = MF.Tabs({ tabs: tabDefs, value: first, onChange: show });

        const extRows = r.extensions;
        const extTable = MF.VirtualTable({
          maxHeight: 300,
          columns: [
            { label: "Type", width: "1fr", render: (x) => h("b", x.ext) },
            { label: "A files", width: "100px", align: "right", render: (x) => fmt.num(x.countA) },
            { label: "B files", width: "100px", align: "right", render: (x) => fmt.num(x.countB) },
            { label: "A size", width: "120px", align: "right", render: (x) => fmt.size(x.sizeA) },
            { label: "B size", width: "120px", align: "right", render: (x) => fmt.size(x.sizeB) },
            { label: "Change", width: "130px", align: "right", render: (x) => { const d = x.sizeB - x.sizeA; return d ? h("span", { style: { color: d > 0 ? "var(--green)" : "var(--red)" } }, `${d > 0 ? "+" : ""}${fmt.size(d)}`) : h("span.faint", "—"); } },
          ],
          rows: extRows,
        });

        const errors = r.a.errorCount + r.b.errorCount;
        replace(
          out,
          verdict,
          stats,
          errors ? MF.Callout("amber", h("b", `${fmt.plural(errors, "item")} couldn't be read`), " and were left out. ", [...r.a.errors, ...r.b.errors].slice(0, 3).map((e) => `${e.rel || "."}: ${e.error}`).join(" · ")) : null,
          h("div.card", tabs.el, h("div", { style: { padding: "10px 12px" } }, h("div.input", icon("search"), search)), tableBox),
          MF.Section("File types", `${extRows.length} kinds of files`),
          h("div.card", extTable.el),
        );
        show(first);
      }

      const col = {
        path: { label: "Path", width: "minmax(260px, 2fr)", render: (x) => MF.PathCell(x.rel, x.kind), title: (x) => x.rel },
        size: (key, label = "Size") => ({ label, width: "110px", align: "right", render: (x) => fmt.size(x[key]) }),
        date: (label, key) => ({ label, width: "170px", render: (x) => fmt.date(x[key]) }),
      };

      return {
        el,
        onShow(params) {
          if (params.a) dropA.set([params.a]);
          if (params.b) dropB.set([params.b]);
        },
      };
    },
  };
})();

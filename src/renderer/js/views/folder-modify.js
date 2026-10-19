/* Folder › Modify */
(function () {
  "use strict";

  const { h, icon, fmt, api, replace } = MF;

  MF.views["folder-modify"] = {
    crumb: "Folder",
    title: "Modify",
    subtitle: "Make the dates in copies match the original: every file and folder, plus EXIF dates inside photos and videos.",
    mount() {
      const options = { created: true, modified: true, exif: true, requireSameSize: false, includeAll: false };
      let plan = null;

      const refInfo = h("div");
      const refDrop = MF.DropZone({
        label: "Reference",
        step: 1,
        hint: "folder or HTML index",
        accept: "folder-or-html",
        title: "Drop the original folder or its HTML index",
        subtitle: "Its dates are the goal; it is never changed",
        glyph: "folder",
        onChange: (paths, infos) => {
          inputsChanged();
          describeReference(infos[0]);
        },
      });
      const tgtDrop = MF.DropZone({ label: "Targets", step: 2, hint: "one or more folders", accept: "folder", multiple: true, title: "Drop the folders to fix", subtitle: "Copies of the reference whose dates are wrong", moreTitle: "Add another folder", glyph: "clockfix", onChange: () => inputsChanged() });

      const chips = [
        MF.ChipToggle({ label: "Created dates", iconName: "calendar", checked: options.created, onChange: (v) => setOpt("created", v) }),
        MF.ChipToggle({ label: "Modified dates", iconName: "clock", checked: options.modified, onChange: (v) => setOpt("modified", v) }),
        MF.ChipToggle({ label: "EXIF dates", iconName: "photo", checked: options.exif, onChange: (v) => setOpt("exif", v) }),
      ];
      const sizeOpt = MF.Option({ title: "Also require identical file sizes", desc: "Off: names and nesting must match; sizes may differ (EXIF edits change sizes slightly).", checked: options.requireSameSize, onChange: (v) => setOpt("requireSameSize", v) });
      const sysOpt = MF.Option({ title: "Include system files", desc: ".DS_Store and similar are normally ignored on both sides.", checked: options.includeAll, onChange: (v) => setOpt("includeAll", v) });
      const checkBtn = MF.Button("Check", { kind: "primary", size: "lg", iconName: "search", disabled: true, onClick: check });

      const out = h("div.stack");
      const summary = h("div.summary", "Choose a reference and at least one target.");
      const applyBtn = MF.Button("Fix dates", { kind: "primary", size: "lg", iconName: "check", disabled: true, onClick: apply });

      const el = h(
        "div.stack",
        h("div.grid2", refDrop.el, tgtDrop.el),
        refInfo,
        h(
          "div.card.card-pad",
          h("div.row", { style: { flexWrap: "wrap", justifyContent: "space-between" } }, h("div", h("div", { style: { fontWeight: "650" } }, "What to fix"), h("div.muted.small", "Nothing changes until you review the check and apply.")), h("div.chips", chips.map((c) => c.el)), checkBtn),
          h("div", { style: { marginTop: "10px", borderTop: "1px solid var(--line)" } }, sizeOpt.el, sysOpt.el),
        ),
        out,
        h("div.actionbar", summary, h("span.spacer"), applyBtn),
      );

      function setOpt(key, v) {
        options[key] = v;
        inputsChanged();
      }

      function inputsChanged() {
        plan = null;
        replace(out);
        checkBtn.disabled = !(refDrop.paths.length && tgtDrop.paths.length);
        update();
      }

      async function describeReference(info) {
        replace(refInfo);
        if (!info || !info.isHtml) return;
        try {
          const idx = await api.run("folder.indexInfo", { path: info.path });
          replace(
            refInfo,
            MF.Callout(
              idx.hasExif ? "green" : "blue",
              h("b", `HTML index of “${idx.name}”`),
              idx.kind === "legacy"
                ? " made by file_directory.py. It holds created and modified dates (no EXIF dates)."
                : ` made ${fmt.nice(idx.generatedAt)}${idx.stats ? ` · ${fmt.plural(idx.stats.files, "file")}, ${fmt.plural(idx.stats.dirs, "folder")}` : ""}${idx.hasExif ? " · includes EXIF dates" : " · without EXIF dates"}.`,
            ),
          );
        } catch (err) {
          replace(refInfo, MF.Callout("red", h("b", "Can't use this HTML file. "), err.message));
        }
      }

      async function check() {
        try {
          plan = await MF.busy("Checking folders…", "folder.modifyPlan", { reference: refDrop.paths[0], targets: tgtDrop.paths, options }, (p) => {
            const labels = { "scan-reference": "Reading the reference…", "exif-reference": "Reading EXIF dates in the reference…", "scan-target": `Reading ${p.target || "target"}…`, "exif-target": `Reading EXIF dates in ${p.target || "target"}…` };
            return { label: labels[p.phase], ratio: p.total ? p.done / p.total : null, left: p.scanned ? `${fmt.num(p.scanned)} items` : p.total ? `${fmt.num(p.done)} of ${fmt.num(p.total)} files` : "" };
          });
          render();
        } catch (err) {
          MF.fail(err);
        }
        update();
      }

      function diffTable(target) {
        const exifTitle = (d) => (d.exif ? d.exif.map(([tag, now, to]) => `${tag}: ${now === null ? "none" : now} → ${to}`).join("\n") : "");
        return MF.VirtualTable({
          maxHeight: 340,
          rows: target.diffs,
          columns: [
            { label: "Item", width: "minmax(220px, 1.6fr)", render: (d) => MF.PathCell(d.rel, d.kind), title: (d) => d.rel || "(the folder itself)" },
            { label: "Created", width: "minmax(250px, 1.3fr)", render: (d) => (d.birth ? MF.DateChange(d.birth.now, d.birth.to) : h("span.faint", "matches")) },
            { label: "Modified", width: "minmax(250px, 1.3fr)", render: (d) => (d.mtime ? MF.DateChange(d.mtime.now, d.mtime.to) : h("span.faint", "matches")) },
            { label: "EXIF", width: "120px", render: (d) => (d.exif ? h("span.badge.accent", `${d.exif.length} tag${d.exif.length === 1 ? "" : "s"}`) : h("span.faint", "—")), title: exifTitle },
          ],
        });
      }

      function problemList(title, items, render) {
        if (!items.length) return null;
        return h("details.group", h("summary", icon("chevron"), title, h("span.c", fmt.num(items.length))), h("div", { style: { maxHeight: "180px", overflowY: "auto" } }, items.map((x) => h("div.tagrow", { style: { gridTemplateColumns: "1fr" } }, h("div.v", render(x))))));
      }

      function targetCard(t) {
        const head = h(
          "div.card-head",
          h("div.tcard", { style: { padding: "0", flex: "1", minWidth: "0" } }, h("div.top", h("div.disk", icon("folder")), h("div", { style: { minWidth: "0" } }, h("div.tn", t.name), h("div.tp", t.path)))),
          h("div.right", statusBadge(t)),
        );
        if (t.status === "error") return h("div.card", head, h("div.card-pad", MF.Callout("red", t.error)));
        if (t.status === "mismatch") {
          const c = t.problemCounts;
          return h(
            "div.card",
            head,
            h(
              "div.card-pad",
              MF.Callout("red", h("b", "This folder doesn't match the reference, so it won't be changed. "), `${fmt.num(c.missing)} missing, ${fmt.num(c.extra)} extra, ${fmt.num(c.kind)} file/folder mix-ups${c.size ? `, ${fmt.num(c.size)} size differences` : ""}.`),
            ),
            problemList("Missing here (in the reference only)", t.problems.missing, (x) => x),
            problemList("Extra here (not in the reference)", t.problems.extra, (x) => x),
            problemList("File in one, folder in the other", t.problems.kind, (x) => `${x.rel}  (reference: ${x.ref}, here: ${x.target})`),
            problemList("Different sizes", t.problems.size, (x) => `${x.rel}  (${fmt.size(x.ref)} vs ${fmt.size(x.target)})`),
          );
        }
        if (t.status === "same") {
          return h("div.card", head, h("div.card-pad", MF.Callout("green", h("b", "Already identical. "), `Structure matches and every date${options.exif ? " (including EXIF)" : ""} is already right.`)));
        }
        const s = t.summary;
        const tableBox = h("div");
        let shown = false;
        const toggle = MF.Button("Show changes", {
          size: "sm",
          iconName: "list",
          onClick: () => {
            shown = !shown;
            replace(tableBox, shown ? diffTable(t).el : null);
            replace(toggle.querySelector("span"), shown ? "Hide changes" : "Show changes");
          },
        });
        return h(
          "div.card",
          head,
          h(
            "div.card-pad",
            h(
              "div.opchips",
              { style: { marginTop: "0" } },
              h("span.opchip", h("span.dot", { style: { background: "var(--accent)" } }), h("b", fmt.num(s.items)), " items to fix"),
              h("span.opchip", h("span.dot", { style: { background: "var(--blue)" } }), h("b", fmt.num(s.created)), " created dates"),
              h("span.opchip", h("span.dot", { style: { background: "var(--teal)" } }), h("b", fmt.num(s.modified)), " modified dates"),
              plan.options.exif ? h("span.opchip", h("span.dot", { style: { background: "var(--amber)" } }), h("b", fmt.num(s.exif)), " photos/videos with EXIF dates") : null,
              h("span.spacer"),
              toggle,
            ),
            t.sizeWarnings ? h("div.small.muted", { style: { marginTop: "10px" } }, `${fmt.plural(t.sizeWarnings, "file")} differ in size from the reference (allowed).`) : null,
          ),
          tableBox,
        );
      }

      function statusBadge(t) {
        if (t.status === "match") return h("span.badge.accent", icon("check"), "Matches · ready to fix");
        if (t.status === "same") return h("span.badge.green", icon("check"), "Already identical");
        if (t.status === "mismatch") return h("span.badge.red", icon("x"), "Doesn't match");
        return h("span.badge.red", icon("alert"), "Can't read");
      }

      function render() {
        if (!plan) return replace(out);
        replace(
          out,
          MF.Section("Check results", `Reference: ${plan.reference.name}${plan.reference.kind === "html" ? " (HTML index)" : ""}`),
          plan.notes.map((n) => MF.Callout("amber", n)),
          plan.targets.map(targetCard),
        );
      }

      function update() {
        const ready = plan ? plan.targets.filter((t) => t.status === "match") : [];
        const items = ready.reduce((s, t) => s + t.summary.items, 0);
        applyBtn.disabled = !ready.length;
        replace(applyBtn.querySelector("span"), ready.length ? `Fix ${fmt.plural(ready.length, "folder")}` : "Fix dates");
        replace(summary, plan ? h("span", h("b", fmt.num(ready.length)), ` of ${fmt.plural(plan.targets.length, "folder")} ready · `, h("b", fmt.num(items)), " items to fix") : refDrop.paths.length && tgtDrop.paths.length ? "Press Check to compare them." : "Choose a reference and at least one target.");
      }

      async function apply() {
        const ready = plan.targets.filter((t) => t.status === "match");
        const ok = await MF.confirm({
          title: `Fix dates in ${fmt.plural(ready.length, "folder")}?`,
          message: `${fmt.num(ready.reduce((s, t) => s + t.summary.items, 0))} items get the reference's dates${plan.options.exif ? ", including EXIF dates inside photos and videos" : ""}. Nothing in the reference is touched, and you can undo this from History.`,
          confirm: "Fix dates",
          iconName: "clockfix",
        });
        if (!ok) return;
        try {
          const res = await MF.busy("Fixing dates…", "folder.modifyApply", { planId: plan.id }, (p) => ({
            label: p.phase === "exif" ? `Writing EXIF dates in ${p.target}…` : p.phase === "dates" ? `Setting dates in ${p.target}…` : undefined,
            ratio: p.total ? p.done / p.total : null,
            left: p.total ? `${fmt.num(p.done)} of ${fmt.num(p.total)} items` : "",
            current: p.current,
          }));
          const problems = res.targets.reduce((s, t) => s + t.timeFailures.length + t.exifFailed.length, 0);
          const remaining = res.targets.reduce((s, t) => s + (t.remaining || 0), 0);
          plan = null;
          replace(
            out,
            MF.Section("Done"),
            MF.undoCallout(
              problems || remaining ? "amber" : "green",
              h(
                "span",
                h("b", problems || remaining ? "Finished with some problems. " : "All dates now match the reference. "),
                res.targets.map((t) => `${t.name}: ${fmt.num(t.datesSet)} dates set, ${fmt.num(t.exifWritten)} EXIF updates${t.remaining === 0 ? ", verified" : t.remaining ? `, ${t.remaining} still differ` : ""}`).join(" · "),
              ),
              res.historyId,
              () => MF.toast("Restored the previous dates", { kind: "success" }),
            ),
            res.targets.flatMap((t) => [...t.timeFailures, ...t.exifFailed.map((f) => ({ path: f.rel, error: f.error }))]).slice(0, 8).map((f) => MF.Callout("red", h("b", fmt.base(f.path)), ` — ${f.error}`)),
          );
          MF.toast("Dates fixed", { kind: problems ? "warn" : "success" });
        } catch (err) {
          MF.fail(err);
        }
        update();
      }

      return {
        el,
        onShow(params) {
          if (params.reference) refDrop.set([params.reference]);
          if (params.targets) tgtDrop.set(params.targets);
        },
      };
    },
  };
})();

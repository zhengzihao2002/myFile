/* Shared detailed date editor for EXIF › Modify */
(function () {
  "use strict";

  const { h, icon, fmt, api, replace } = MF;

  const LABEL = { exif: "EXIF date", created: "Created", modified: "Modified" };
  const NOTE = { exif: "inside the file", created: "file system", modified: "file system" };
  const TZ_KIND = { stored: ["green", "stored"], unknown: ["", "not chosen"], chosen: ["accent", "selected"] };

  const dirOf = (rel) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");

  // One editor and one decision model for a file, loose files and folders.
  function build() {
    {
      let single = true;
      // ----- state -----
      let zones = [];
      let scan = null; // { scanId, folder, counts, birthSupported }
      const rows = new Map(); // path -> row
      const status = new Map(); // path -> "saved" | "partial" | "skipped"
      const decisions = new Map(); // path -> decision state
      let tab = "todo";
      let current = null;
      let outcome = null;
      let outcomeToken = 0;
      let mediaToken = 0;
      let table = null;
      let historyId = null;
      const savedPaths = new Set();
      let scanToken = 0;
      let scanJob = null;
      let saving = null;
      let pendingPaths = null;

      // ----- review screen -----
      const countsLine = h("div.bt-counts");
      const tabsHost = h("div");
      let tabs = null;
      const listHost = h("div.bt-listhost");
      const zoneLine = h("div.bt-zoneline");
      const bulkHost = h("div.bt-bulk");
      const footHost = h("div.bt-foot");
      const listCol = h("div.bt-list", h("div.bt-listhead", countsLine, zoneLine, tabsHost), listHost, bulkHost, footHost);

      const stageName = h("div.fname");
      const stageCount = h("span.muted.small.num");
      const prevBtn = MF.Button("", { kind: "ghost", size: "sm", iconName: "chevron", title: "Previous", onClick: () => step(-1) });
      prevBtn.querySelector("svg").style.transform = "rotate(180deg)";
      const nextBtn = MF.Button("", { kind: "ghost", size: "sm", iconName: "chevron", title: "Next", onClick: () => step(1) });
      const stageView = h("div.stage-view");
      const stage = h(
        "div.stage",
        h("div.stage-bar", prevBtn, nextBtn, stageName, stageCount, h("span.spacer"), MF.Button("Reveal", { kind: "ghost", size: "sm", iconName: "reveal", onClick: () => current && api.reveal(current.path) }), MF.Button("Open", { kind: "ghost", size: "sm", iconName: "external", onClick: () => current && api.open(current.path) })),
        stageView,
      );
      const sideScroll = h("div.scroll");
      const sideFoot = h("div.bt-sidefoot");
      const side = h("div.panel-side.bt-side", sideScroll, sideFoot);
      const review = h("div.bt-review.hidden", listCol, stage, side);
      const root = h("div.bt-root.embedded.single", review);
      const loading = h("div.bt-loading.hidden");
      root.appendChild(loading);
      let banner = null; // single file: the note with Undo after a save

      // ----- helpers -----
      // A zone chooser with no "automatic" entry: the file's own zone is pre-selected when it has one,
      // otherwise it shows "Choose a zone…" until the user picks.
      function zonePicker({ placeholder, value = "", onChange }) {
        const options = () => [placeholder ? h("option", { value: "", disabled: true }, placeholder) : null, zones.map((z) => h("option", { value: z.id }, z.label)), h("option", { value: "other" }, "Other UTC offset…")];
        const sel = h("select.select", { on: { change: () => { custom.classList.toggle("hidden", sel.value !== "other"); if (sel.value !== "other") fire(); else custom.focus(); } } });
        const custom = h("input.select.hidden", { placeholder: "UTC offset, e.g. +08:00", style: { width: "100%", paddingRight: "10px", marginTop: "6px" }, on: { input: () => fire() } });
        sel.style.width = "100%";
        const el = h("div.bt-zonepick", sel, custom);
        const known = (v) => zones.some((z) => z.id === v);
        function fire() {
          onChange(sel.value === "other" ? custom.value.trim() : sel.value);
        }
        replace(sel, options());
        sel.value = value === "" ? "" : known(value) ? value : "other";
        if (sel.value === "other") {
          custom.classList.remove("hidden");
          custom.value = value;
        }
        return { el };
      }

      function defaultDecision(row) {
        return { choice: row.hasExif ? "all-exif" : "", oneTarget: "modified", oneSrc: "created", tz: "", writeTz: false };
      }
      const decisionFor = (row) => {
        if (!decisions.has(row.path)) decisions.set(row.path, defaultDecision(row));
        return decisions.get(row.path);
      };
      function toDecision(d) {
        const set = {};
        if (d.choice.startsWith("all-")) {
          const src = d.choice.slice(4);
          for (const f of ["exif", "created", "modified"]) if (f !== src) set[f] = src;
        } else if (d.choice === "one" && d.oneTarget !== d.oneSrc) set[d.oneTarget] = d.oneSrc;
        return { set, tz: d.tz || null, writeTz: Boolean(d.writeTz) };
      }
      const options = () => ({ useGps: reviewGps.checked });

      // ----- scan -----
      const reviewGps = { checked: true };
      async function startReview(res) {
        const continuing = scan && scan.scanId === res.scanId;
        const selectedPath = continuing && current ? current.path : null;
        ++outcomeToken;
        ++mediaToken;
        scan = res;
        single = res.single;
        root.classList.toggle("single", single);
        prevBtn.classList.toggle("hidden", single);
        nextBtn.classList.toggle("hidden", single);
        zones = res.zones;
        rows.clear();
        if (!continuing) {
          status.clear();
          decisions.clear();
          savedPaths.clear();
          tab = "todo";
        }
        historyId = res.historyId || null;
        for (const [file, state] of res.savedPaths || []) {
          savedPaths.add(file);
          if (!status.has(file)) status.set(file, state);
        }
        current = null;
        outcome = null;
        banner = null;
        bulkGps = false;
        for (const r of res.rows) rows.set(r.path, r);
        for (const file of status.keys()) if (!rows.has(file)) status.delete(file);
        for (const file of decisions.keys()) if (!rows.has(file)) decisions.delete(file);
        review.classList.remove("hidden");
        loading.classList.add("hidden");
        renderLeft();
        MF.refreshHeader();
        const list = allRows().filter(inTab);
        const first = list.find((r) => r.path === selectedPath) || list[0];
        if (first) await select(first);
        else renderEmpty();
      }

      async function reclassify() {
        if (!scan || saving) return;
        const session = scan;
        const token = scanToken;
        try {
          const res = await api.run("exif.batchClassify", { scanId: scan.scanId, options: options() });
          if (token !== scanToken || session !== scan) return;
          const fresh = new Map(res.rows.map((r) => [r.path, r]));
          for (const [p, r] of [...rows]) if (!status.has(p) && !fresh.has(p)) rows.delete(p);
          for (const [p, r] of fresh) if (!status.has(p)) rows.set(p, r);
          scan.counts = res.counts;
          renderLeft();
          if (current && rows.has(current.path)) await select(rows.get(current.path));
          else selectTabRow();
        } catch (err) {
          MF.fail(err);
        }
      }

      // ----- left column -----
      const allRows = () => [...rows.values()].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
      const todoRows = () => allRows().filter((r) => !status.has(r.path));
      const inTab = (r) => (tab === "todo" ? !status.has(r.path) : tab === "saved" ? status.get(r.path) === "saved" || status.get(r.path) === "partial" : status.get(r.path) === "skipped");

      function itemCell(row) {
        const st = status.get(row.path);
        const pairs = Object.values(row.pairs).filter(Boolean).length;
        const bits = [];
        if (pairs === 1) bits.push(row.pairs.exifModified ? "EXIF ≠ Modified" : row.pairs.exifCreated ? "EXIF ≠ Created" : "Created ≠ Modified");
        else if (pairs > 1) bits.push("dates differ");
        if (!row.hasExif) bits.push("no EXIF date");
        return h(
          `div.bt-item${current && current.path === row.path ? ".on" : ""}`,
          icon(row.movie ? "video" : "photo"),
          h("div.bt-txt", h("div.bt-name", row.name), h("div.bt-sub", st ? (st === "saved" ? "Saved" : st === "partial" ? "Saved, still differs" : "Skipped") : row.needsZone ? (row.suggestZone ? "Time zone: choose it (GPS suggests one)" : "Time zone unknown: choose it") : `${fmt.gap(row.spreadMs)} apart${bits.length ? ` · ${bits.join(" · ")}` : ""}`), dirOf(row.rel) ? h("div.bt-dir", dirOf(row.rel)) : null),
        );
      }

      function renderLeft() {
        const c = scan.counts;
        const todo = todoRows().length;
        const saved = [...status.values()].filter((s) => s !== "skipped").length;
        const skipped = [...status.values()].filter((s) => s === "skipped").length;
        replace(
          countsLine,
          h("span", h("b", fmt.num(todo)), " to decide"),
          h("span.muted", ` · ${fmt.num(c.agree)} already agree`),
          c.noExif ? h("span.muted", ` · ${fmt.num(c.noExif)} without an EXIF date`) : null,
          c.needsZone ? h("span.muted", ` · ${fmt.num(c.needsZone)} need a time zone`) : null,
        );
        replace(zoneLine, h("label.bt-gps", h("input", { type: "checkbox", checked: reviewGps.checked, on: { change: (e) => { reviewGps.checked = e.target.checked; reclassify(); } } }), " Suggest the time zone from GPS"));
        tabs = MF.Tabs({ tabs: [{ id: "todo", label: "To do", count: todo }, { id: "saved", label: "Saved", count: saved }, { id: "skipped", label: "Skipped", count: skipped }], value: tab, onChange: (id) => {
          if (saving) return tabs.set(tab);
          tab = id;
          table.setRows(allRows().filter(inTab));
          selectTabRow();
        } });
        replace(tabsHost, tabs.el);
        table = MF.VirtualTable({ fill: true, rowHeight: 58, columns: [{ label: "Files", width: "1fr", render: itemCell }], rows: allRows().filter(inTab), empty: tab === "todo" ? "Nothing left to decide." : "Nothing here yet.", onRowClick: (row) => select(row) });
        replace(listHost, table.el);
        renderBulk(todo);
        renderFoot();
      }

      function refreshCounts() {
        const todo = todoRows().length;
        tabs.setCount("todo", todo);
        tabs.setCount("saved", [...status.values()].filter((s) => s !== "skipped").length);
        tabs.setCount("skipped", [...status.values()].filter((s) => s === "skipped").length);
        replace(countsLine, h("span", h("b", fmt.num(todo)), " to decide"), h("span.muted", ` · ${fmt.num(scan.counts.agree)} already agree`), scan.counts.noExif ? h("span.muted", ` · ${fmt.num(scan.counts.noExif)} without an EXIF date`) : null, scan.counts.needsZone ? h("span.muted", ` · ${fmt.num(scan.counts.needsZone)} need a time zone`) : null);
        table.setRows(allRows().filter(inTab));
        renderBulk(todo);
        renderFoot();
      }

      // Files a bulk action can take: those whose zone is known, plus (if ticked) those with a GPS suggestion.
      let bulkGps = false;
      const bulkRows = () => todoRows().filter((r) => !r.needsZone || (bulkGps && r.suggestZone));
      function renderBulk(todoAll) {
        const todo = bulkRows().length;
        const waiting = todoAll - todo;
        const suggestable = todoRows().filter((r) => r.needsZone && r.suggestZone).length;
        const gpsBox = suggestable ? h("label.bt-gps", { style: { display: "flex", margin: "6px 0 8px" } }, h("input", { type: "checkbox", checked: bulkGps, on: { change: (e) => { bulkGps = e.target.checked; renderBulk(todoRows().length); } } }), ` Also use the GPS-suggested zone for ${fmt.num(suggestable)} file${suggestable === 1 ? "" : "s"}`) : null;
        if (!todo) return replace(bulkHost, gpsBox, waiting ? h("div.muted.small", `${fmt.plural(waiting, "file")} need${waiting === 1 ? "s" : ""} a time zone chosen one by one.`) : null);
        const sel = h("select.select", h("option", { value: "exif" }, "Everything follows EXIF"), h("option", { value: "modified" }, "Everything follows Modified"), h("option", { value: "created", disabled: !scan.birthSupported }, "Everything follows Created"));
        const btn = MF.Button(`Apply to all ${fmt.num(todo)} remaining`, { size: "sm", iconName: "wand", onClick: () => bulk(sel.value, btn) });
        replace(bulkHost, h("div.muted.small", { style: { marginBottom: "6px" } }, `Same choice for every file whose time zone is known${waiting ? ` (${fmt.num(waiting)} more need a zone chosen one by one)` : ""}:`), gpsBox, h("div.row", { style: { gap: "8px", flexWrap: "wrap" } }, sel, btn));
      }

      function renderFoot() {
        if (!savedPaths.size) return replace(footHost);
        replace(
          footHost,
          h("span.muted.small", `${fmt.num(savedPaths.size)} saved`),
          h("span.spacer"),
          historyId ? MF.Button("Undo all", { size: "sm", iconName: "undo", onClick: undoAll }) : null,
          MF.Button("Scan again", { size: "sm", iconName: "refresh", onClick: () => runScanAgain() }),
        );
      }

      async function runScanAgain() {
        if (!scan || saving) return;
        return openPaths(scan.paths, { fresh: true });
      }

      async function undoAll() {
        if (saving) return;
        const ok = await MF.confirm({ title: "Undo everything saved here?", message: "The previous EXIF values, file dates and folder dates are put back.", confirm: "Undo", iconName: "undo" });
        if (!ok) return;
        try {
          const res = await MF.busy("Undoing…", "history.revert", { id: historyId }, (p) => ({ ratio: p.total ? p.done / p.total : null, left: p.phase === "exif" ? "Restoring EXIF" : "Restoring dates" }));
          MF.toast("Everything put back", { kind: "success", detail: res.failures.length ? `${res.failures.length} item(s) couldn't be restored.` : undefined });
          await runScanAgain();
        } catch (err) {
          MF.fail(err);
        }
      }

      // ----- choosing a file -----
      function step(delta) {
        if (saving) return;
        const list = allRows().filter(inTab);
        const i = list.findIndex((r) => current && r.path === current.path);
        const next = list[Math.min(list.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta))];
        if (next) select(next);
      }

      async function select(row) {
        if (saving) return;
        current = row;
        outcome = null;
        replace(sideScroll, h("div.muted.small", "Reading dates…"));
        replace(sideFoot);
        if (table) {
          table.redraw();
          table.scrollTo((r) => r.path === row.path);
        }
        const list = allRows().filter(inTab);
        const i = list.findIndex((r) => r.path === row.path);
        stageName.textContent = row.name;
        stageCount.textContent = list.length > 1 && i >= 0 ? `${i + 1} of ${list.length}` : "";
        prevBtn.disabled = i <= 0;
        nextBtn.disabled = i < 0 || i >= list.length - 1;
        showMedia(row);
        await refreshOutcome();
      }

      function renderEmpty() {
        ++outcomeToken;
        ++mediaToken;
        current = null;
        outcome = null;
        prevBtn.disabled = true;
        nextBtn.disabled = true;
        stageName.textContent = "";
        stageCount.textContent = "";
        const emptySelection = !scan.counts.total;
        const title = emptySelection ? "No photos or videos found" : tab !== "todo" ? "Nothing here yet" : scan.counts.review ? "All decided" : "Everything agrees";
        const text = emptySelection ? "Choose photos, videos or a folder containing them." : tab !== "todo" ? "Choose another tab to keep reviewing files." : scan.counts.review ? "Every file has been saved or skipped. You can revisit files in Saved or Skipped, or scan again." : `All ${fmt.num(scan.counts.total)} photos and videos already have the same EXIF, created and modified dates.`;
        replace(stageView, MF.Empty({ iconName: emptySelection ? "photo" : "check", title, text }));
        replace(sideScroll, h("div.row", { style: { gap: "8px", flexWrap: "wrap" } }, MF.Button("Scan again", { iconName: "refresh", onClick: runScanAgain }), null));
        replace(sideFoot);
      }

      function selectTabRow() {
        const list = allRows().filter(inTab);
        const row = list.find((r) => current && r.path === current.path) || list[0];
        if (row) select(row);
        else renderEmpty();
      }

      async function showMedia(row) {
        const token = ++mediaToken;
        replace(stageView, h("div.placeholder", "Loading…"));
        const show = (url) => replace(stageView, h("div.fit", h("img", { src: url, alt: "", draggable: false })));
        try {
          const p = await api.run("exif.batchPreview", { path: row.path });
          if (token !== mediaToken) return;
          if (p.type === "image") return show(p.url);
          if (p.type === "video") {
            const video = h("video", { src: p.url, controls: true, preload: "metadata", playsInline: true });
            video.addEventListener("error", async () => {
              const poster = await api.run("exif.poster", { path: row.path }).catch(() => null);
              if (token !== mediaToken) return;
              if (poster && poster.url) replace(stageView, h("div.fit.with-note", h("img", { src: poster.url, alt: "" }), h("p.muted.small", { style: { margin: "0" } }, "This video's format can't play here; showing a still frame.")));
              else replace(stageView, MF.Empty({ iconName: "video", title: "Can't play this video here", text: "Use Open to watch it in QuickTime Player." }));
            });
            return replace(stageView, h("div.fit", video));
          }
          if (p.type === "pending") {
            replace(stageView, h("div.placeholder", "Making a preview…"));
            const res = await api.run("exif.preview", { path: row.path }).catch(() => null);
            if (token !== mediaToken) return;
            if (res && res.url) return show(res.url);
          }
          replace(stageView, MF.Empty({ iconName: "photo", title: "No preview", text: "This file type can't be previewed here." }));
        } catch (err) {
          if (token === mediaToken) replace(stageView, MF.Empty({ iconName: "alert", title: "Can't show this file", text: err.message }));
        }
      }

      // ----- the right panel -----
      async function refreshOutcome() {
        if (!current) return;
        const token = ++outcomeToken;
        outcome = null;
        replace(sideFoot);
        const d = decisionFor(current);
        try {
          const o = await api.run("exif.batchOutcome", { scanId: scan.scanId, path: current.path, decision: toDecision(d) });
          if (token !== outcomeToken) return;
          outcome = o;
          renderPanel();
        } catch (err) {
          if (token !== outcomeToken) return;
          replace(sideScroll, MF.Callout("red", err.message));
          replace(sideFoot);
        }
      }

      function setDecision(patch) {
        if (!current || saving) return;
        Object.assign(decisionFor(current), patch);
        refreshOutcome();
      }

      // "2023-05-01 12:00:00 UTC+08:00" -> the time and the zone, shown apart.
      const splitTz = (text) => {
        const m = /^(.*\S)\s+(UTC[+-]\d{2}:\d{2})$/.exec(text || "");
        return m ? [m[1], m[2]] : [text || "", ""];
      };
      const timeEl = (text) => {
        const [t, z] = splitTz(text);
        return h("span", t, z ? h("span.tz", ` ${z}`) : null);
      };

      const offsetValue = (min) => `${min < 0 ? "-" : "+"}${String(Math.floor(Math.abs(min) / 60)).padStart(2, "0")}:${String(Math.abs(min) % 60).padStart(2, "0")}`;

      // Compare in the file's zone (or the user's explicit choice), never the
      // current Mac's zone. An unzoned photo needs a choice before comparison.
      function dateCard(o) {
        const blocks = ["exif", "created", "modified"]
          .filter((k) => o.fields[k])
          .map((k) => {
            const f = o.fields[k];
            const none = k === "exif" && !o.hasExif;
            const changed = !o.needsZone && f.changed;
            return h(
              `div.bt-field${changed ? ".changed" : ""}`,
              h("div.bt-fh", h("span.bt-fl", LABEL[k]), h("span.bt-fn", NOTE[k])),
              h(`div.bt-now${changed ? ".old" : ""}`, none ? h("span.faint", "none") : o.needsZone ? (k === "exif" ? timeEl(f.originalText) : h("span.faint", "Choose time zone")) : timeEl(f.beforeText)),
              k === "exif" && !none && !o.needsZone && f.originalText !== f.beforeText ? h(`div.bt-mac${changed ? ".bt-stored-old" : ""}`, "Stored: ", timeEl(f.originalText)) : null,
              changed ? h("div.bt-after", icon("arrow"), h("span", timeEl(f.afterText))) : null,
            );
          });
        const verdict = o.needsZone ? h("span.badge.amber", icon("alert"), "Choose a time zone to compare") : o.agree ? h("span.badge.green", icon("check"), "All agree after saving") : h("span.badge.amber", icon("alert"), `Still ${fmt.gap(o.spreadMs)} apart`);
        return h("div.kv", h("div.kvh", icon("calendar"), "Dates", h("div.right", verdict)), blocks);
      }

      /** Everything saving would change, as { label, from, to }. */
      function changeLines(o) {
        const lines = [];
        if (o.needsZone) return lines;
        for (const k of ["exif", "created", "modified"]) {
          const f = o.fields[k];
          if (f && f.changed) lines.push({ label: k === "exif" ? "EXIF date (stored)" : LABEL[k], from: (k === "exif" ? f.originalText : f.beforeText) || "none", to: f.afterText });
        }
        if (o.writeTz) lines.push({ label: "Time zone in the file", from: o.tzOriginal, to: o.tz.label });
        return lines;
      }
      const lineEls = (lines) => lines.map((l) => h("div.bt-chg", h("span.bt-chg-l", l.label), h("span.bt-chg-old", l.from), icon("arrow"), h("span.bt-chg-new", l.to)));

      function changesCard(o) {
        if (o.needsZone) return null;
        const lines = changeLines(o);
        return h("div.kv", h("div.kvh", icon("check"), "What will change"), h("div.bt-chgs", lines.length ? lineEls(lines) : h("div.muted.small", "Nothing would change.")));
      }

      function tzCard(o, d) {
        const [badgeKind, badgeText] = o.movie && o.tz.kind === "unknown" ? ["", "optional"] : TZ_KIND[o.tz.kind] || ["", o.tz.kind];
        const current = d.tz || (o.tz.kind === "stored" ? o.tz.zone || offsetValue(o.tz.offsetMin) : "");
        const chosen = o.tz.kind === "chosen";
        const picker = zonePicker({ placeholder: current ? null : "Choose a zone…", value: current, onChange: (v) => v && v !== current && setDecision({ tz: v, writeTz: true }) });
        const chip = (label, id) => h(`button.bt-chip${current === id ? ".on" : ""}`, { type: "button", on: { click: () => setDecision({ tz: id, writeTz: true }) } }, label);
        const note = o.needsZone ? MF.Callout("amber", "Choose a time zone to save.") : null;
        const suggest = o.suggest && !(chosen && d.tz === o.suggest.zone)
          ? h("div.bt-suggest", icon("pin"), h("span", "GPS suggests ", h("b", o.suggest.label), ". Near a border it can be the neighbouring zone."), MF.Button("Use this", { size: "sm", onClick: () => setDecision({ tz: o.suggest.zone, writeTz: true }) }))
          : null;
        const changing = chosen && o.writeTz;
        const stored = o.tzOriginal.startsWith("none") ? (o.movie ? "UTC; local offset not stored" : "Not stored") : o.tzOriginal;
        const nextOffset = `UTC${offsetValue(o.tz.offsetMin)}`;
        const nowText = h("div.bt-tzmain", changing ? h("span", h("span.bt-chg-old", stored), icon("arrow"), h("span.bt-chg-new", nextOffset)) : stored);
        return h(
          "div.kv",
          h("div.kvh", icon("clock"), "Time zone", h("div.right", h(`span.badge${badgeKind ? "." + badgeKind : ""}`, badgeText))),
          h(
            "div.bt-tz",
            nowText,
            note,
            suggest,
            h("div.bt-chips", chip("Beijing", "Asia/Shanghai"), chip("Eastern", "America/New_York")),
            picker.el,
            h("div", { style: { marginTop: "8px", borderTop: "1px solid var(--line)" } }, MF.Option({ title: "Save offset in file", checked: o.writeTz || d.writeTz, onChange: (v) => setDecision({ writeTz: v }) }).el),
          ),
        );
      }

      function choiceCard(o, d) {
        const exifOn = o.hasExif;
        const make = (value, title, sub, disabled) => h(`button.bt-choice${d.choice === value ? ".on" : ""}`, { type: "button", disabled: Boolean(disabled), on: { click: () => setDecision({ choice: value }) } }, h("div.t", title), h("div.s", sub));
        const oneSel = (key, opts) => {
          const s = h("select.select", opts.map(([v, l]) => h("option", { value: v }, l)));
          s.value = d[key];
          s.addEventListener("change", () => setDecision({ [key]: s.value, choice: "one" }));
          return s;
        };
        const fieldOpts = [["modified", "Modified"], ...(o.fields.created ? [["created", "Created"]] : []), ["exif", "EXIF date"]];
        return h(
          "div.kv",
          h("div.kvh", icon("wand"), "What should win?"),
          h(
            "div.bt-choices",
            make("all-exif", "Everything follows the EXIF date", exifOn ? "Sets Created and Modified." : "No EXIF date", !exifOn),
            make("all-modified", "Everything follows Modified", exifOn ? "Sets EXIF and Created." : "Adds EXIF and sets Created."),
            o.fields.created ? make("all-created", "Everything follows Created", exifOn ? "Sets EXIF and Modified." : "Adds EXIF and sets Modified.") : null,
            h(`div.bt-choice.one${d.choice === "one" ? ".on" : ""}`, { on: { click: (e) => e.target.tagName !== "SELECT" && setDecision({ choice: "one" }) } }, h("div.t", "Change just one"), h("div.row", { style: { gap: "6px", flexWrap: "wrap", marginTop: "6px" } }, "Set", oneSel("oneTarget", fieldOpts), "to match", oneSel("oneSrc", fieldOpts.filter(([v]) => v !== "exif" || exifOn)))),
          ),
        );
      }

      function renderPanel() {
        const o = outcome;
        if (!o) return;
        const d = decisionFor(current);
        replace(sideScroll, banner, dateCard(o), tzCard(o, d), choiceCard(o, d), changesCard(o), single ? h("div.card.card-pad", { style: { paddingTop: "8px", paddingBottom: "8px" } }, zoneLine) : null);
        const valid = (d.choice !== "" || o.writeTz) && !(d.choice === "one" && d.oneTarget === d.oneSrc && !o.writeTz) && !o.needsZone;
        const saveBtn = MF.Button(single ? "Save" : "Save & next", { kind: "primary", size: "lg", iconName: "check", disabled: !valid || !o.anything, onClick: () => save(saveBtn) });
        const skipBtn = single ? null : MF.Button("Skip", { kind: "ghost", onClick: skip });
        const saveHint = o.needsZone ? h("span.muted.small", "Choose the time zone first") : !valid ? h("span.muted.small", "Choose what should win") : !o.anything ? h("span.muted.small", "Nothing would change") : null;
        replace(sideFoot, skipBtn, single ? null : h("span.spacer"), saveHint, saveBtn);
      }

      // ----- saving -----
      function advance() {
        tab = "todo";
        tabs.set(tab);
        table.setRows(todoRows());
        const list = todoRows();
        const next = list.find((r) => r.rel > current.rel) || list[0];
        if (next) select(next);
        else renderEmpty();
      }

      async function save(button) {
        if (saving || !current || !outcome || outcome.path !== current.path) return;
        const row = current;
        const decision = toDecision(decisionFor(row));
        const lines = changeLines(outcome);
        const token = scanToken;
        const scanId = scan.scanId;
        const operation = saving = {};
        try {
          const res = await MF.withSpinner(button, () => api.run("exif.batchApply", { scanId, items: [{ path: row.path, decision }] }));
          if (token !== scanToken) return;
          if (saving === operation) saving = null;
          const r = res.results[0];
          if (!r.ok) {
            MF.toast("Couldn't save this file", { kind: "warn", detail: r.error });
            return;
          }
          historyId = res.historyId || historyId;
          if (single) {
            const note = r.agree === false ? "Saved, but the dates still differ." : "Saved. Folder dates were kept.";
            const reopened = openFile(row.path);
            const reloadToken = scanToken;
            await reopened;
            if (reloadToken !== scanToken || !current || current.path !== row.path) return;
            banner = MF.undoCallout(r.agree === false ? "amber" : "green", h("span", h("b", note), h("div.bt-chgs", lineEls(lines))), res.historyId, () => openFile(row.path));
            renderPanel();
            return;
          }
          savedPaths.add(row.path);
          status.set(row.path, r.agree === false ? "partial" : "saved");
          MF.toast(`Saved ${row.name}`, { kind: r.agree === false ? "warn" : "success", timeout: 9000, detail: lines.map((l) => `${l.label}: ${l.from} → ${l.to}`).join("\n") || undefined });
          refreshCounts();
          advance();
        } catch (err) {
          if (token === scanToken) MF.fail(err);
        } finally {
          if (saving === operation) saving = null;
          if (!saving && pendingPaths !== null) {
            const paths = pendingPaths;
            pendingPaths = null;
            openPaths(paths);
          }
        }
      }

      function skip() {
        if (saving || !current) return;
        status.set(current.path, "skipped");
        refreshCounts();
        advance();
      }

      async function bulk(policy, button) {
        if (saving) return;
        const targets = bulkRows().filter((r) => policy !== "exif" || r.hasExif);
        if (!targets.length) {
          MF.toast("Nothing to apply", { kind: "warn", detail: "None of the remaining files has an EXIF date to follow." });
          return;
        }
        const skippedNoExif = bulkRows().length - targets.length;
        const waitingZone = todoRows().length - bulkRows().length;
        const word = { exif: "the EXIF date", modified: "the Modified date", created: "the Created date" }[policy];
        const ok = await MF.confirm({
          title: `Fix ${fmt.plural(targets.length, "file")}?`,
          message: `For each file, the other dates are set to ${word}${policy === "exif" ? "" : " (the EXIF date is written into the file)"}, read in each file's own time zone. ${skippedNoExif ? `${fmt.plural(skippedNoExif, "file")} without an EXIF date stay in the list. ` : ""}${waitingZone ? `${waitingZone === 1 ? "1 file whose time zone is unknown stays" : `${fmt.num(waitingZone)} files whose time zone is unknown stay`} in the list for you to do one by one. ` : ""}Folder dates are kept, and everything can be undone from History.`,
          confirm: "Fix them",
          iconName: "wand",
        });
        if (!ok) return;
        const items = targets.map((r) => ({ path: r.path, decision: { set: Object.fromEntries(["exif", "created", "modified"].filter((f) => f !== policy).map((f) => [f, policy])), tz: r.needsZone ? r.suggestZone : null, writeTz: false } }));
        try {
          const rate = MF.rateTracker("items", "files");
          const res = await MF.busy("Fixing dates…", "exif.batchApply", { scanId: scan.scanId, items }, (p) => ({ label: "Fixing dates…", ratio: p.total ? p.done / p.total : null, left: `${fmt.num(p.done || 0)} of ${fmt.num(p.total || 0)} files`, right: rate(p.done || 0, p.total), current: p.current }));
          historyId = res.historyId || historyId;
          let failed = 0;
          for (const r of res.results) {
            if (r.ok) {
              status.set(r.path, r.agree === false ? "partial" : "saved");
              savedPaths.add(r.path);
            } else failed++;
          }
          refreshCounts();
          MF.toast(`${fmt.plural(res.ok, "file")} fixed`, { kind: failed ? "warn" : "success", detail: failed ? `${failed} couldn't be saved and are still in the list.` : res.foldersRestored ? `${fmt.plural(res.foldersRestored, "folder")} kept their original dates.` : undefined });
          const next = todoRows()[0];
          if (next) select(next);
          else renderEmpty();
        } catch (err) {
          if (!err.cancelled) MF.fail(err);
        }
      }

      // All Modify inputs use this queue, including already-agreeing files and
      // files without dates. Only discovery differs from the one-file editor.
      async function openPaths(paths, { fresh = false } = {}) {
        const previous = !fresh && paths.length ? scan : null;
        const token = ++scanToken;
        ++outcomeToken;
        ++mediaToken;
        if (scanJob) scanJob.cancel();
        scanJob = null;
        if (!previous) { scan = null; current = null; }
        outcome = null;
        banner = null;
        review.classList.add("hidden");
        loading.classList.toggle("hidden", !paths.length);
        replace(stageView);
        replace(sideScroll);
        replace(sideFoot);
        pendingPaths = saving ? paths.slice() : null;
        if (!paths.length) return;
        replace(loading, MF.Empty({ iconName: "search", title: "Reading photos and videos…", text: "Finding files and reading their dates. Nothing is changed." }));
        if (saving) {
          replace(loading, MF.Empty({ iconName: "clock", title: "Finishing the current save…", text: "Your new selection will open next." }));
          return;
        }
        const label = h("span", previous ? "Updating file selection…" : "Finding photos and videos…");
        const bar = h("div");
        const progress = h("div.progress.indeterminate", { attrs: { role: "progressbar", "aria-label": "Reading files", "aria-valuemin": "0", "aria-valuemax": "100" } }, bar);
        const percent = h("span.pct");
        const count = h("span.l", previous ? "Reusing files already read…" : "Finding files…");
        const speed = h("span.r", "measuring speed…");
        const active = h("div.current");
        const cancel = MF.Button("Cancel", { onClick: () => scanJob && scanJob.cancel() });
        replace(loading, h("div.busy-card", h("div.title", h("div.spinner"), label), h("div.bar-row", progress, percent), h("div.detail", count, speed), active, h("div.foot", cancel)));
        let latest = { phase: previous ? "update" : "find", found: 0 };
        let phase = latest.phase;
        let rate = MF.rateTracker("items", "files");
        function showProgress(p) {
          if (token !== scanToken) return;
          if (phase !== p.phase) { phase = p.phase; rate = MF.rateTracker("items", "files"); }
          latest = p;
          const reading = p.phase === "read";
          label.textContent = reading ? "Reading dates…" : p.phase === "update" ? "Updating file selection…" : "Finding photos and videos…";
          count.textContent = reading ? `${fmt.num(p.done)} of ${fmt.num(p.total)} files` : p.phase === "update" ? "Reusing files already read…" : `${fmt.num(p.found)} files found`;
          speed.textContent = rate(reading ? p.done : p.found, reading ? p.total : undefined);
          const ratio = reading && p.total ? p.done / p.total : null;
          progress.classList.toggle("indeterminate", ratio === null);
          percent.textContent = ratio === null ? "" : `${Math.floor(ratio * 100)}%`;
          if (ratio !== null) { bar.style.width = `${ratio * 100}%`; progress.setAttribute("aria-valuenow", Math.floor(ratio * 100)); }
          else progress.removeAttribute("aria-valuenow");
          const names = p.active && p.active.length ? p.active : p.current ? [p.current] : [];
          active.classList.toggle("multi", names.length > 1);
          replace(active, names.map((name) => h("div", name)));
        }
        const timer = setInterval(() => showProgress(latest), 1000);
        const job = scanJob = api.start("exif.batchScan", { paths, scanId: previous ? previous.scanId : undefined, options: { reviewAll: true, useGps: reviewGps.checked } }, { onProgress: showProgress });
        try {
          const res = await job.promise;
          if (token !== scanToken) return;
          await startReview(res);
        } catch (err) {
          if (token !== scanToken) return;
          replace(loading, MF.Empty({ iconName: err.cancelled ? "photo" : "alert", title: err.cancelled ? "Reading cancelled" : "Couldn't read these files", text: err.cancelled ? "No files were changed." : err.message }), MF.Button("Try again", { onClick: () => openPaths(paths) }));
        } finally {
          clearInterval(timer);
          if (scanJob === job) scanJob = null;
        }
      }

      const openFile = (file) => openPaths([file], { fresh: true });

      return { el: root, openFile, openPaths };
    }
  }

  MF.dateEditor = build;
})();

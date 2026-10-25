/* EXIF › Batch Modify */
(function () {
  "use strict";

  const { h, icon, fmt, api, replace } = MF;

  const LABEL = { exif: "EXIF date", created: "Created", modified: "Modified" };
  const NOTE = { exif: "inside the file", created: "what Finder shows", modified: "what Finder shows" };
  const TZ_KIND = { stored: ["green", "stored in the file"], gps: ["blue", "guessed from GPS"], unknown: ["amber", "not known yet"], chosen: ["accent", "chosen by you"] };

  const dirOf = (rel) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");

  MF.views["exif-batch"] = {
    crumb: "EXIF",
    title: "Batch Modify",
    subtitle: "Find photos and videos whose EXIF, created and modified dates disagree, and settle them one after another.",
    full: true,
    mount() {
      // ----- state -----
      let zones = [];
      let system = { zone: "", label: "" };
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
      let savedCount = 0;

      // ----- setup screen -----
      const drop = MF.DropZone({
        accept: "folder",
        title: "Drop the folder to check",
        subtitle: "Subfolders are included. Only photos and videos are looked at.",
        glyph: "folder",
        onChange: () => (scanBtn.disabled = !drop.paths.length),
      });
      const setupGps = MF.Option({ title: "Guess the time zone from GPS", desc: "For files that store no time zone but do have a GPS position. A position near a border can land in the wrong zone, so this is approximate. Files with neither are never guessed: you choose their zone, one file at a time.", checked: true, onChange: () => {} });
      const scanBtn = MF.Button("Scan", { kind: "primary", size: "lg", iconName: "search", disabled: true, onClick: runScan });
      const setup = h(
        "div.bt-setup",
        h("div.bt-setup-in", drop.el, h("div.card.card-pad", { style: { paddingTop: "4px", paddingBottom: "4px" } }, setupGps.el), h("div.card.card-pad", h("div", { style: { fontWeight: "650", marginBottom: "6px" } }, "How it works"), h("ol.bt-how", h("li", "It looks at every photo and video in the folder (and below) and compares the EXIF date, the created date and the modified date. Files where all three agree are skipped."), h("li", "For each file that doesn't agree you see the picture and decide which date wins, or change just one. A time zone is taken into account, so a photo taken in Beijing and fixed on a Mac in New York still agrees when it goes back to China. If a photo says nothing about its time zone and has no GPS, you pick the zone for that file yourself."), h("li", "Folders keep their own modified dates: writing inside a folder can move it, so it is put back and the original is saved in History.")), h("div.row", { style: { marginTop: "14px", justifyContent: "flex-end" } }, scanBtn))),
      );

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
      const root = h("div.bt-root", setup, review);

      // ----- helpers -----
      function zonePicker({ autoLabel, onChange, value = "" }) {
        const quick = () => zones.map((z) => h("option", { value: z.id }, z.label));
        const sel = h("select.select", { on: { change: () => { custom.classList.toggle("hidden", sel.value !== "other"); fire(); } } });
        const custom = h("input.select.hidden", { placeholder: "+08:00", style: { width: "84px", paddingRight: "10px", marginLeft: "6px" }, on: { input: () => fire() } });
        const el = h("div.row", { style: { gap: "0" } }, sel, custom);
        let cur = value;
        function fire() {
          cur = sel.value === "other" ? custom.value.trim() : sel.value;
          onChange(cur);
        }
        function fill() {
          replace(sel, h("option", { value: "" }, autoLabel()), quick(), h("option", { value: "other" }, "Other UTC offset…"));
          sel.value = zones.some((z) => z.id === cur) || cur === "" ? cur : "other";
          custom.classList.toggle("hidden", sel.value !== "other");
          if (sel.value === "other") custom.value = cur;
        }
        fill();
        return {
          el,
          fill,
          get value() {
            return cur;
          },
          set(v) {
            cur = v || "";
            fill();
          },
        };
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
      async function runScan() {
        const folder = drop.paths[0];
        if (!folder) return;
        try {
          const res = await MF.busy("Looking at photos and videos…", "exif.batchScan", { folder, options: { useGps: setupGps.checked } }, (p) => {
            if (p.phase === "find") return { label: "Finding photos and videos…", left: `${fmt.num(p.found)} found` };
            return { label: "Reading dates…", ratio: p.total ? p.done / p.total : null, left: `${fmt.num(p.done)} of ${fmt.num(p.total)} files` };
          });
          startReview(res);
        } catch (err) {
          if (!err.cancelled) MF.fail(err);
        }
      }

      let reviewGps = null;
      function startReview(res) {
        scan = res;
        zones = res.zones;
        system = res.system;
        rows.clear();
        status.clear();
        decisions.clear();
        historyId = null;
        savedCount = 0;
        current = null;
        outcome = null;
        for (const r of res.rows) rows.set(r.path, r);
        reviewGps = { checked: setupGps.checked };
        tab = "todo";
        setup.classList.add("hidden");
        review.classList.remove("hidden");
        renderLeft();
        MF.refreshHeader();
        const first = todoRows()[0];
        if (first) select(first);
        else renderEmpty();
      }

      async function reclassify() {
        if (!scan) return;
        try {
          const res = await api.run("exif.batchClassify", { scanId: scan.scanId, options: options() });
          const fresh = new Map(res.rows.map((r) => [r.path, r]));
          for (const [p, r] of [...rows]) if (!status.has(p) && !fresh.has(p)) rows.delete(p);
          for (const [p, r] of fresh) if (!status.has(p)) rows.set(p, r);
          scan.counts = res.counts;
          renderLeft();
          if (current && rows.has(current.path)) current = rows.get(current.path);
          if (current) refreshOutcome();
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
          h("div.bt-txt", h("div.bt-name", row.name), h("div.bt-sub", st ? (st === "saved" ? "Saved" : st === "partial" ? "Saved, still differs" : "Skipped") : row.needsZone ? "Time zone unknown: choose it" : `${fmt.gap(row.spreadMs)} apart${bits.length ? ` · ${bits.join(" · ")}` : ""}`), dirOf(row.rel) ? h("div.bt-dir", dirOf(row.rel)) : null),
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
        replace(zoneLine, h("label.bt-gps", h("input", { type: "checkbox", checked: reviewGps.checked, on: { change: (e) => { reviewGps.checked = e.target.checked; reclassify(); } } }), " Guess from GPS first"));
        tabs = MF.Tabs({ tabs: [{ id: "todo", label: "To do", count: todo }, { id: "saved", label: "Saved", count: saved }, { id: "skipped", label: "Skipped", count: skipped }], value: tab, onChange: (id) => { tab = id; table.setRows(allRows().filter(inTab)); } });
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

      function renderBulk(todoAll) {
        const todo = todoRows().filter((r) => !r.needsZone).length;
        const waiting = todoAll - todo;
        if (!todo) return replace(bulkHost, waiting ? h("div.muted.small", `${fmt.plural(waiting, "file")} need${waiting === 1 ? "s" : ""} a time zone chosen one by one.`) : null);
        const sel = h("select.select", h("option", { value: "exif" }, "Everything follows EXIF"), h("option", { value: "modified" }, "Everything follows Modified"), h("option", { value: "created", disabled: !scan.birthSupported }, "Everything follows Created"));
        const btn = MF.Button(`Apply to all ${fmt.num(todo)} remaining`, { size: "sm", iconName: "wand", onClick: () => bulk(sel.value, btn) });
        replace(bulkHost, h("div.muted.small", { style: { marginBottom: "6px" } }, `Same choice for every file whose time zone is known${waiting ? ` (${fmt.num(waiting)} more need a zone chosen one by one)` : ""}:`), h("div.row", { style: { gap: "8px", flexWrap: "wrap" } }, sel, btn));
      }

      function renderFoot() {
        if (!savedCount) return replace(footHost);
        replace(
          footHost,
          h("span.muted.small", `${fmt.num(savedCount)} saved`),
          h("span.spacer"),
          historyId ? MF.Button("Undo all", { size: "sm", iconName: "undo", onClick: undoAll }) : null,
          MF.Button("Scan again", { size: "sm", iconName: "refresh", onClick: () => runScanAgain() }),
        );
      }

      async function runScanAgain() {
        if (!scan) return;
        try {
          const res = await MF.busy("Looking at photos and videos…", "exif.batchScan", { folder: scan.folder, options: options() }, (p) => (p.phase === "find" ? { label: "Finding photos and videos…", left: `${fmt.num(p.found)} found` } : { label: "Reading dates…", ratio: p.total ? p.done / p.total : null, left: `${fmt.num(p.done)} of ${fmt.num(p.total)} files` }));
          const keepGps = reviewGps.checked;
          startReview(res);
          reviewGps.checked = keepGps;
          renderLeft();
        } catch (err) {
          if (!err.cancelled) MF.fail(err);
        }
      }

      async function undoAll() {
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
        const list = allRows().filter(inTab);
        const i = list.findIndex((r) => current && r.path === current.path);
        const next = list[Math.min(list.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta))];
        if (next) select(next);
      }

      async function select(row) {
        current = row;
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
        current = null;
        stageName.textContent = "";
        stageCount.textContent = "";
        replace(stageView, MF.Empty({ iconName: "check", title: scan.counts.review ? "All decided" : "Everything agrees", text: scan.counts.review ? "Every file that needed a decision has been saved or skipped. Scan again to check the folder." : `All ${fmt.num(scan.counts.total)} photos and videos already have the same EXIF, created and modified dates.` }));
        replace(sideScroll, MF.Callout("green", h("b", "Nothing left to fix. "), "Folders were kept at their original modified dates."), h("div.row", { style: { gap: "8px" } }, MF.Button("Scan again", { iconName: "refresh", onClick: runScanAgain }), MF.Button("Another folder", { iconName: "folder", onClick: reset })));
        replace(sideFoot);
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

      function dateCard(o) {
        if (o.needsZone) {
          // Without a zone the EXIF time can't be turned into a moment, so nothing is compared or promised yet.
          const f = o.fields;
          const block = (k, now, sub) => h("div.bt-field", h("div.bt-fh", h("span.bt-fl", LABEL[k]), h("span.bt-fn", NOTE[k])), h("div.bt-now", now), sub ? h("div.bt-mac", sub) : null);
          return h(
            "div.kv",
            h("div.kvh", icon("calendar"), "Dates", h("div.right", h("span.badge.amber", icon("alert"), "Choose a time zone to compare"))),
            block("exif", o.exifAsStored.replace(" (no time zone)", ""), "no time zone stored"),
            f.created ? block("created", timeEl(f.beforeMacOnly || f.created.beforeMac), "on this Mac") : null,
            block("modified", timeEl(f.modified.beforeMac), "on this Mac"),
          );
        }
        const blocks = ["exif", "created", "modified"]
          .filter((k) => o.fields[k])
          .map((k) => {
            const f = o.fields[k];
            const none = k === "exif" && !o.hasExif;
            return h(
              `div.bt-field${f.changed ? ".changed" : ""}`,
              h("div.bt-fh", h("span.bt-fl", LABEL[k]), h("span.bt-fn", NOTE[k])),
              h("div.bt-now", none ? h("span.faint", "none") : timeEl(f.beforeText)),
              !none && !o.mac.same ? h("div.bt-mac", "this Mac: ", timeEl(f.beforeMac)) : null,
              k === "exif" && o.exifAsStored ? h("div.bt-mac", `stored as ${o.exifAsStored}`) : null,
              f.changed ? h("div.bt-after", icon("arrow"), h("span", timeEl(f.afterText)), !o.mac.same ? h("span.bt-mac", ["this Mac: ", timeEl(f.afterMac)]) : null) : null,
            );
          });
        const verdict = o.agree ? h("span.badge.green", icon("check"), "All agree after saving") : h("span.badge.amber", icon("alert"), `Still ${fmt.gap(o.spreadMs)} apart`);
        return h("div.kv", h("div.kvh", icon("calendar"), "Dates", h("div.right", verdict)), blocks);
      }

      function tzCard(o, d) {
        const [badgeKind, badgeText] = TZ_KIND[o.tz.kind] || ["", o.tz.kind];
        const picker = zonePicker({ autoLabel: () => (o.needsZone ? "Choose a zone…" : "Automatic (as above)"), value: d.tz, onChange: (v) => setDecision({ tz: v, writeTz: v ? true : d.writeTz }) });
        const chip = (label, id) => h(`button.bt-chip${d.tz === id ? ".on" : ""}`, { type: "button", on: { click: () => setDecision({ tz: id, writeTz: true }) } }, label);
        const warn = o.needsZone ? MF.Callout("amber", h("b", "Choose this file's time zone. "), "It doesn't say where it was taken and has no GPS, so nothing is guessed. Until you choose, it can't be saved.") : o.tz.kind === "gps" ? h("div.muted.small", "Worked out from where the photo was taken. Near a border it can be the neighbouring zone.") : null;
        return h(
          "div.kv",
          h("div.kvh", icon("clock"), "Time zone", h("div.right", h(`span.badge.${badgeKind}`, badgeText))),
          h(
            "div.bt-tz",
            h("div.bt-tzmain", o.needsZone ? "Not chosen yet" : o.tz.label),
            o.movie ? h("div.muted.small", "A video stores one exact moment, so the zone only decides how it is written out and shown here.") : null,
            warn,
            h("div.row", { style: { gap: "6px", flexWrap: "wrap", marginTop: "8px" } }, chip("Beijing", "Asia/Shanghai"), chip("Eastern", "America/New_York"), picker.el),
            h("div", { style: { marginTop: "8px", borderTop: "1px solid var(--line)" } }, MF.Option({ title: "Save this time zone in the file", desc: (o.movie ? "Writes Keys:CreationDate with the offset." : "Writes the OffsetTime tags in its EXIF.") + " Without it, this file asks for its zone again next time.", checked: o.writeTz || d.writeTz, onChange: (v) => setDecision({ writeTz: v }) }).el),
          ),
        );
      }

      function choiceCard(o, d) {
        const exifOn = o.hasExif;
        const make = (value, title, sub, disabled) => h(`button.bt-choice${d.choice === value ? ".on" : ""}`, { type: "button", disabled: Boolean(disabled), on: { click: () => setDecision({ choice: value }) } }, h("div.t", title), h("div.s", sub));
        const exifText = o.fields.exif.beforeText;
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
            make("all-exif", "Everything follows the EXIF date", exifOn ? `Created and Modified become ${exifText}` : "This file has no EXIF date", !exifOn),
            make("all-modified", "Everything follows Modified", exifOn ? "EXIF and Created become the Modified date" : "Adds an EXIF date and sets Created to the Modified date"),
            o.fields.created ? make("all-created", "Everything follows Created", exifOn ? "EXIF and Modified become the Created date" : "Adds an EXIF date and sets Modified to the Created date") : null,
            h(`div.bt-choice.one${d.choice === "one" ? ".on" : ""}`, { on: { click: (e) => e.target.tagName !== "SELECT" && setDecision({ choice: "one" }) } }, h("div.t", "Change just one"), h("div.row", { style: { gap: "6px", flexWrap: "wrap", marginTop: "6px" } }, "Set", oneSel("oneTarget", fieldOpts), "to match", oneSel("oneSrc", fieldOpts.filter(([v]) => v !== "exif" || exifOn)))),
          ),
        );
      }

      function renderPanel() {
        const o = outcome;
        const d = decisionFor(current);
        replace(sideScroll, dateCard(o), tzCard(o, d), choiceCard(o, d));
        const valid = d.choice !== "" && !(d.choice === "one" && d.oneTarget === d.oneSrc) && !o.needsZone;
        const saveBtn = MF.Button("Save & next", { kind: "primary", size: "lg", iconName: "check", disabled: !valid || !o.anything, onClick: () => save(saveBtn) });
        const skipBtn = MF.Button("Skip", { kind: "ghost", onClick: skip });
        replace(sideFoot, skipBtn, h("span.spacer"), o.needsZone ? h("span.muted.small", "Choose the time zone first") : !valid ? h("span.muted.small", "Choose what should win") : !o.anything ? h("span.muted.small", "Nothing would change") : null, saveBtn);
      }

      // ----- saving -----
      function advance() {
        const list = todoRows();
        const next = list.find((r) => r.rel > current.rel) || list[0];
        if (next) select(next);
        else renderEmpty();
      }

      async function save(button) {
        const row = current;
        const d = decisionFor(row);
        try {
          const res = await MF.withSpinner(button, () => api.run("exif.batchApply", { scanId: scan.scanId, items: [{ path: row.path, decision: toDecision(d) }] }));
          const r = res.results[0];
          if (!r.ok) {
            MF.toast("Couldn't save this file", { kind: "warn", detail: r.error });
            return;
          }
          historyId = res.historyId || historyId;
          savedCount++;
          status.set(row.path, r.agree === false ? "partial" : "saved");
          refreshCounts();
          advance();
        } catch (err) {
          MF.fail(err);
        }
      }

      function skip() {
        status.set(current.path, "skipped");
        refreshCounts();
        advance();
      }

      async function bulk(policy, button) {
        const targets = todoRows().filter((r) => !r.needsZone && (policy !== "exif" || r.hasExif));
        if (!targets.length) {
          MF.toast("Nothing to apply", { kind: "warn", detail: "None of the remaining files has an EXIF date to follow." });
          return;
        }
        const skippedNoExif = todoRows().filter((r) => !r.needsZone).length - targets.length;
        const waitingZone = todoRows().filter((r) => r.needsZone).length;
        const word = { exif: "the EXIF date", modified: "the Modified date", created: "the Created date" }[policy];
        const ok = await MF.confirm({
          title: `Fix ${fmt.plural(targets.length, "file")}?`,
          message: `For each file, the other dates are set to ${word}${policy === "exif" ? "" : " (the EXIF date is written into the file)"}, read in each file's own time zone. ${skippedNoExif ? `${fmt.plural(skippedNoExif, "file")} without an EXIF date stay in the list. ` : ""}${waitingZone ? `${waitingZone === 1 ? "1 file whose time zone is unknown stays" : `${fmt.num(waitingZone)} files whose time zone is unknown stay`} in the list for you to do one by one. ` : ""}Folder dates are kept, and everything can be undone from History.`,
          confirm: "Fix them",
          iconName: "wand",
        });
        if (!ok) return;
        const items = targets.map((r) => ({ path: r.path, decision: { set: Object.fromEntries(["exif", "created", "modified"].filter((f) => f !== policy).map((f) => [f, policy])), tz: null, writeTz: false } }));
        try {
          const rate = MF.rateTracker("items", "files");
          const res = await MF.busy("Fixing dates…", "exif.batchApply", { scanId: scan.scanId, items }, (p) => ({ label: "Fixing dates…", ratio: p.total ? p.done / p.total : null, left: `${fmt.num(p.done || 0)} of ${fmt.num(p.total || 0)} files`, right: rate(p.done || 0, p.total), current: p.current }));
          historyId = res.historyId || historyId;
          let failed = 0;
          for (const r of res.results) {
            if (r.ok) {
              status.set(r.path, r.agree === false ? "partial" : "saved");
              savedCount++;
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

      function reset() {
        scan = null;
        rows.clear();
        status.clear();
        decisions.clear();
        review.classList.add("hidden");
        setup.classList.remove("hidden");
        drop.clear();
        scanBtn.disabled = true;
        MF.refreshHeader();
      }

      return {
        el: root,
        async onShow() {
          try {
            const z = await api.run("exif.batchZones");
            zones = z.zones;
            system = z.system;
          } catch {
            // the pickers just stay short
          }
        },
      };
    },
  };
})();

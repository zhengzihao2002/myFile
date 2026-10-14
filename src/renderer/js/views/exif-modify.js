/* EXIF › Modify */
(function () {
  "use strict";

  const { h, icon, fmt, api, replace } = MF;

  function fileCell(row) {
    return h(
      "span.cell-path",
      { title: row.path },
      icon(row.movie || /\.(mov|mp4|m4v|3gp|avi|mkv|mts|webm)$/i.test(row.name) ? "video" : "photo"),
      h("span", row.name),
    );
  }

  /** Shows an Undo button for a history entry. */
  function undoCallout(kind, text, historyId, after) {
    const box = h("div");
    const undo = historyId
      ? MF.Button("Undo", {
          size: "sm",
          iconName: "undo",
          onClick: async () => {
            const ok = await MF.confirm({ title: "Undo these changes?", message: "The previous EXIF values and file dates are put back.", confirm: "Undo" });
            if (!ok) return;
            try {
              const res = await MF.busy("Undoing…", "history.revert", { id: historyId }, (p) => ({ ratio: p.total ? p.done / p.total : null, left: p.phase === "exif" ? "Restoring EXIF" : "Restoring dates" }));
              MF.toast("Changes undone", { kind: "success", detail: res.failures.length ? `${res.failures.length} item(s) couldn't be restored.` : undefined });
              replace(box);
              if (after) after();
            } catch (err) {
              MF.fail(err);
            }
          },
        })
      : null;
    replace(box, MF.Callout(kind, h("div.row", { style: { gap: "12px" } }, h("span", { style: { flex: "1" } }, text), undo)));
    return box;
  }

  MF.undoCallout = undoCallout;

  MF.views["exif-modify"] = {
    crumb: "EXIF",
    title: "Modify",
    subtitle: "Copy dates and places from a reference, or set file dates from each file's own EXIF.",
    mount() {
      let mode = "copy";
      const modeSeg = MF.Segmented({
        big: true,
        value: mode,
        options: [
          { value: "copy", label: "Copy from a reference", icon: "wand" },
          { value: "self", label: "Use each file's own date", icon: "calendar" },
        ],
        onChange: (v) => setMode(v),
      });

      const copyPane = buildCopy();
      const selfPane = buildSelf();
      const body = h("div");
      const el = h("div.stack", h("div", modeSeg.el), body);

      function setMode(v) {
        mode = v;
        modeSeg.set(v);
        replace(body, v === "copy" ? copyPane.el : selfPane.el);
      }
      setMode(mode);

      return {
        el,
        onShow(params) {
          if (params.mode) setMode(params.mode);
          if (params.reference) copyPane.setReference(params.reference);
          if (params.paths) selfPane.setPaths(params.paths);
        },
      };
    },
  };

  // ---------------------------------------------------------------------------
  // Copy from a reference
  // ---------------------------------------------------------------------------

  function buildCopy() {
    const options = { date: true, gps: true, camera: false, fileDates: true, all: false };
    let plan = null;
    let job = null;

    const refDrop = MF.DropZone({ label: "Reference", step: 1, hint: "one file", accept: "media", title: "Drop the reference photo or video", subtitle: "Its date, time zone and location are copied", glyph: "photo", onChange: () => inputsChanged() });
    const tgtDrop = MF.DropZone({ label: "Targets", step: 2, hint: "files or folders", accept: "media-or-folder", multiple: true, title: "Drop the photos and videos to change", subtitle: "Folders are searched for photos and videos", moreTitle: "Add more files or folders", glyph: "layers", onChange: () => inputsChanged() });

    const chips = [
      MF.ChipToggle({ label: "Date & time", checked: options.date, iconName: "clock", onChange: (v) => set("date", v) }),
      MF.ChipToggle({ label: "Location", checked: options.gps, iconName: "pin", onChange: (v) => set("gps", v) }),
      MF.ChipToggle({ label: "Camera & lens", checked: options.camera, iconName: "camera", onChange: (v) => set("camera", v) }),
    ];
    const fileDates = MF.Option({ title: "Also set the files' created and modified dates", desc: "So Finder shows the same date as the photo itself.", checked: options.fileDates, onChange: (v) => set("fileDates", v) });
    const all = MF.Option({ title: "Copy every metadata tag", desc: "Advanced. Copies all writable tags (keywords, ratings, maker notes…). This can't be undone.", checked: options.all, onChange: (v) => set("all", v) });

    const refSummary = h("div");
    const previewHead = h("div.card-head", h("h3", "Preview"), h("span.sub", "Nothing is changed until you apply."), h("div.right"));
    const table = MF.VirtualTable({
      maxHeight: 380,
      empty: "Add a reference and some targets to see what will change.",
      columns: [
        { label: "File", width: "minmax(180px, 1.1fr)", render: fileCell, title: (r) => r.path },
        { label: "Date taken", width: "minmax(220px, 1.4fr)", render: (r) => (options.date ? MF.Change(fmt.exif(r.current.date), fmt.exif(r.next.date)) : h("span.faint", "not copied")) },
        { label: "Location", width: "minmax(200px, 1.2fr)", render: (r) => (options.gps ? MF.Change(r.current.gps, r.next.gps) : h("span.faint", "not copied")) },
        { label: "File dates", width: "minmax(130px, 0.7fr)", render: (r) => (!options.fileDates || r.next.fileMs === null ? h("span.faint", "not set") : r.changes.fileDates ? h("span", { title: `Created ${fmt.date(r.current.createdMs)}\nModified ${fmt.date(r.current.modifiedMs)}\n→ ${fmt.date(r.next.fileMs)}` }, "Will be set") : h("span.faint", "already right")) },
        { label: "Picture", width: "minmax(200px, 1fr)", render: pictureCell },
        { label: "Status", width: "120px", render: (r) => (willChange(r) ? h("span.badge.accent", "Will change") : h("span.badge.green", icon("check"), "Up to date")) },
      ],
    });
    // What each target looks like compared with the reference (filled in after the preview).
    let pictures = new Map();
    let pictureRun = 0;
    let restoreOn = false;
    const restoreBox = h("div");

    function pictureCell(r) {
      if (r.movie) return h("span.faint", "—");
      const p = pictures.get(r.path);
      if (!p) return h("span.faint", "checking…");
      if (p.status === "same") return h("span.badge.green", icon("check"), "Same picture");
      if (p.status === "transformed") return h("span.badge.red", { title: "It's the reference's picture, but turned. Copying metadata doesn't change the picture." }, icon("alert"), p.label);
      if (p.status === "different") return h("span.faint", { title: "A different photo from the reference; that's normal when copying a date or place to other photos." }, "Different photo");
      return h("span.faint", "can't compare");
    }

    const toRestore = (r) => restoreOn && r.canRestore && pictures.get(r.path) && pictures.get(r.path).status === "transformed";
    const willChange = (r) => r.willWrite || toRestore(r);

    async function checkPictures(forPlan) {
      const runId = ++pictureRun;
      pictures = new Map();
      renderRestore();
      if (forPlan.reference.movie) {
        for (const r of forPlan.rows) pictures.set(r.path, { status: "unknown" });
        table.setRows(forPlan.rows);
        return;
      }
      const refSig = await MF.picture.signature(forPlan.reference.path);
      const photos = forPlan.rows.filter((r) => !r.movie);
      for (const r of photos) {
        if (runId !== pictureRun) return;
        const sig = refSig ? await MF.picture.signature(r.path) : null;
        pictures.set(r.path, sig && refSig ? MF.picture.compare(refSig, sig) : { status: "unknown" });
      }
      if (runId !== pictureRun) return;
      table.setRows(forPlan.rows);
      renderRestore();
      update();
    }

    function renderRestore() {
      const turned = plan ? plan.rows.filter((r) => pictures.get(r.path) && pictures.get(r.path).status === "transformed") : [];
      if (!turned.length) {
        restoreOn = false;
        return replace(restoreBox);
      }
      const fixable = turned.filter((r) => r.canRestore);
      const names = turned.slice(0, 3).map((r) => `${r.name} (${pictures.get(r.path).label.toLowerCase()})`).join(", ");
      replace(
        restoreBox,
        MF.Callout(
          "amber",
          h("div", h("b", `${fmt.plural(turned.length, "target")} ${turned.length === 1 ? "shows" : "show"} the reference's picture flipped or rotated: `), names, turned.length > 3 ? "…" : "", ". Copying metadata only changes the information inside a file, not the picture."),
          fixable.length
            ? MF.Option({
                title: `Restore ${fixable.length === 1 ? "this picture" : `these ${fixable.length} pictures`} from the reference`,
                desc: "Each one is replaced by an exact copy of the reference. The current version is moved to the Trash, so you can get it back.",
                checked: restoreOn,
                onChange: (v) => {
                  restoreOn = v;
                  table.setRows(plan.rows);
                  update();
                },
              }).el
            : h("div.muted.small", "They're a different file type from the reference, so they can't be replaced by a copy of it."),
        ),
      );
    }
    const result = h("div");
    const summary = h("div.summary");
    const applyBtn = MF.Button("Apply", { kind: "primary", size: "lg", iconName: "check", disabled: true, onClick: apply });

    const el = h(
      "div.stack",
      h("div.grid2", refDrop.el, tgtDrop.el),
      refSummary,
      h(
        "div.card.card-pad",
        h(
          "div.row",
          { style: { justifyContent: "space-between", flexWrap: "wrap" } },
          h("div", h("div", { style: { fontWeight: "650" } }, "What to copy"), h("div.muted.small", "Only the parts you pick are written.")),
          h("div.chips", chips.map((c) => c.el)),
        ),
        h("div", { style: { marginTop: "10px", borderTop: "1px solid var(--line)" } }, fileDates.el, all.el),
      ),
      h("div.card", previewHead, table.el),
      restoreBox,
      result,
      h("div.actionbar", summary, h("span.spacer"), applyBtn),
    );

    function set(key, value) {
      options[key] = value;
      if (key === "all") {
        chips.forEach((c) => (c.el.disabled = value));
      }
      inputsChanged();
    }

    // New inputs: the last result no longer applies.
    function inputsChanged() {
      replace(result);
      refresh();
    }

    function renderReference(ref) {
      if (!ref) return replace(refSummary);
      replace(
        refSummary,
        h(
          "div.grid3",
          MF.Stat({ label: "Reference date", iconName: "calendar", value: ref.date ? fmt.exif(ref.date.split(" ")[0]) : "None", sub: ref.date ? `${ref.date.split(" ").slice(1).join(" ")}${ref.dateSource ? ` · ${ref.dateSource}` : ""}` : "No date in this file", tone: ref.date ? null : "warn" }),
          MF.Stat({ label: "Reference location", iconName: "pin", value: ref.gps ? ref.gps.split(" · ")[0] : "None", sub: ref.gps ? h("a", { href: "#", on: { click: (e) => { e.preventDefault(); api.openExternal(MF.mapsUrl(ref.gpsValue.lat, ref.gpsValue.lon)); } } }, "Open in Maps") : "No GPS in this file" }),
          MF.Stat({ label: "Camera", iconName: "camera", value: ref.camera || "Unknown", sub: ref.movie ? "Video reference" : "Photo reference" }),
        ),
      );
    }

    const refresh = MF.debounce(async () => {
      if (job) job.cancel();
      const reference = refDrop.paths[0];
      const targets = tgtDrop.paths;
      if (!reference) {
        plan = null;
        pictureRun++;
        pictures = new Map();
        renderRestore();
        renderReference(null);
        table.setRows([]);
        update();
        return;
      }
      const right = previewHead.querySelector(".right");
      replace(right, h("span.muted.small", "Reading metadata…"));
      job = api.start("exif.copyPlan", { reference, targets, options }, {
        onProgress: (p) => p.total && replace(right, h("span.muted.small.num", `Reading ${fmt.num(p.done)} of ${fmt.num(p.total)}…`)),
      });
      const mine = job;
      try {
        plan = await job.promise;
        if (mine !== job) return;
        renderReference(plan.reference);
        table.setRows(plan.rows);
        checkPictures(plan);
        replace(right, plan.warnings.length ? h("span.badge.amber", { title: plan.warnings.join("\n") }, icon("alert"), plan.warnings[0]) : null);
        if (plan.skipped.length) MF.toast(`${plan.skipped.length} item(s) skipped`, { kind: "warn", detail: plan.skipped.slice(0, 3).map((s) => `${fmt.base(s.path)}: ${s.reason}`).join("\n") });
      } catch (err) {
        if (err.cancelled) return;
        plan = null;
        table.setRows([]);
        replace(right);
        MF.fail(err);
      }
      update();
    }, 250);

    function update() {
      const n = plan ? plan.rows.length : 0;
      const changing = plan ? plan.rows.filter(willChange).length : 0;
      // Nothing to write when every target already matches.
      applyBtn.disabled = !changing;
      replace(applyBtn.querySelector("span"), changing ? `Apply to ${fmt.plural(changing, "file")}` : "Apply");
      replace(
        summary,
        !n ? "Choose a reference and targets." : changing ? h("span", h("b", fmt.num(changing)), ` of ${fmt.plural(n, "file")} will change`) : h("span", icon("check"), ` All ${fmt.plural(n, "file")} already match the reference. Nothing to apply.`),
      );
    }

    async function apply() {
      if (!plan) return;
      const n = plan.rows.filter(willChange).length;
      if (!n) return;
      const restore = plan.rows.filter(toRestore).map((r) => r.path);
      const ok = await MF.confirm({
        title: `Write to ${fmt.plural(n, "file")}?`,
        message: options.all
          ? "Every metadata tag from the reference is copied into each target. This can't be undone."
          : `Dates, locations and camera details are written inside each file. You can undo this from the result or from History.${restore.length ? ` ${fmt.plural(restore.length, "picture")} will be replaced by a copy of the reference; the current version goes to the Trash.` : ""}`,
        confirm: "Apply",
        iconName: "wand",
      });
      if (!ok) return;
      try {
        const res = await MF.busy("Writing metadata…", "exif.copyApply", { reference: refDrop.paths[0], targets: tgtDrop.paths, options: { ...options, restore } }, (p) => ({
          ratio: p.total ? p.done / p.total : null,
          left: p.phase === "dates" ? "Setting file dates" : `${fmt.num(p.done || 0)} of ${fmt.num(p.total || 0)}`,
          current: p.current,
        }));
        const failed = res.results.filter((r) => !r.ok);
        replace(
          result,
          undoCallout(
            failed.length ? "amber" : "green",
            h("span", h("b", `${fmt.plural(res.ok, "file")} updated.`), failed.length ? ` ${failed.length} failed: ${failed.slice(0, 3).map((f) => `${f.name} (${f.error})`).join(", ")}` : `${res.restored ? ` ${fmt.plural(res.restored, "picture")} restored from the reference.` : ""} Their metadata now matches the reference.`),
            res.undoable ? res.historyId : null,
            () => refresh(),
          ),
        );
        MF.toast("Metadata copied", { kind: failed.length ? "warn" : "success", detail: `${res.ok} of ${res.results.length} files updated` });
        refresh();
      } catch (err) {
        MF.fail(err);
      }
    }

    update();
    return {
      el,
      setReference(p) {
        refDrop.set([p]);
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Use each file's own date
  // ---------------------------------------------------------------------------

  function buildSelf() {
    const options = { created: true, modified: true };
    let plan = null;
    let job = null;

    const drop = MF.DropZone({ label: "Photos and videos", hint: "files or folders", accept: "media-or-folder", multiple: true, title: "Drop photos, videos or folders", subtitle: "Each file's created and modified dates are set to the date inside it", moreTitle: "Add more", glyph: "calendar", onChange: () => { replace(result); refresh(); } });
    const created = MF.Option({ title: "Set the created date", desc: "What Finder shows as “Created”.", checked: true, onChange: (v) => { options.created = v; refresh(); } });
    const modified = MF.Option({ title: "Set the modified date", desc: "What Finder shows as “Modified”.", checked: true, onChange: (v) => { options.modified = v; refresh(); } });
    const tabs = MF.Tabs({
      value: "all",
      tabs: [
        { id: "all", label: "All" },
        { id: "change", label: "Will change" },
        { id: "same", label: "Already right" },
        { id: "nodate", label: "No date" },
      ],
      onChange: (id) => table.setFilter(id === "all" ? null : (r) => r.status === id),
    });
    const head = h("div.card-head", h("h3", "Preview"), h("span.sub", "Dates come from DateTimeOriginal, then CreateDate; videos use their QuickTime dates."), h("div.right"));
    const table = MF.VirtualTable({
      maxHeight: 400,
      empty: "Drop photos or videos above.",
      columns: [
        { label: "File", width: "minmax(150px, 0.8fr)", render: fileCell, title: (r) => r.path },
        { label: "Date inside the file", width: "minmax(200px, 1fr)", render: (r) => (r.exifText ? h("span", { title: r.source }, fmt.exif(r.exifText)) : h("span.faint", "none")) },
        { label: "Created", width: "minmax(250px, 1.15fr)", render: (r) => (r.status !== "nodate" && r.changeCreated ? MF.DateChange(r.createdMs, r.targetMs) : fmt.date(r.createdMs)) },
        { label: "Modified", width: "minmax(250px, 1.15fr)", render: (r) => (r.status !== "nodate" && r.changeModified ? MF.DateChange(r.modifiedMs, r.targetMs) : fmt.date(r.modifiedMs)) },
        { label: "Status", width: "112px", render: (r) => (r.status === "change" ? h("span.badge.accent", "Will change") : r.status === "same" ? h("span.badge.green", icon("check"), "Matches") : h("span.badge.amber", "No date")) },
      ],
    });
    const result = h("div");
    const summary = h("div.summary");
    const applyBtn = MF.Button("Apply", { kind: "primary", size: "lg", iconName: "check", disabled: true, onClick: apply });
    const el = h(
      "div.stack",
      drop.el,
      h("div.card.card-pad", { style: { paddingTop: "6px", paddingBottom: "6px" } }, created.el, modified.el),
      h("div.card", head, tabs.el, table.el),
      result,
      h("div.actionbar", summary, h("span.spacer"), applyBtn),
    );

    const refresh = MF.debounce(async () => {
      if (job) job.cancel();
      const paths = drop.paths;
      if (!paths.length) {
        plan = null;
        table.setRows([]);
        update();
        return;
      }
      const right = head.querySelector(".right");
      replace(right, h("span.muted.small", "Reading dates…"));
      job = api.start("exif.datesPlan", { paths, options }, { onProgress: (p) => p.total && replace(right, h("span.muted.small.num", `Reading ${fmt.num(p.done)} of ${fmt.num(p.total)}…`)) });
      const mine = job;
      try {
        plan = await job.promise;
        if (mine !== job) return;
        table.setRows(plan.rows);
        tabs.setCount("all", plan.rows.length);
        tabs.setCount("change", plan.counts.change);
        tabs.setCount("same", plan.counts.same);
        tabs.setCount("nodate", plan.counts.nodate);
        replace(right);
      } catch (err) {
        if (err.cancelled) return;
        replace(right);
        MF.fail(err);
      }
      update();
    }, 250);

    function update() {
      const n = plan ? plan.counts.change : 0;
      applyBtn.disabled = !n || (!options.created && !options.modified);
      replace(applyBtn.querySelector("span"), n ? `Update ${fmt.plural(n, "file")}` : "Apply");
      replace(
        summary,
        plan
          ? h("span", h("b", fmt.num(plan.counts.change)), " will change · ", h("b", fmt.num(plan.counts.same)), " already right · ", h("b", fmt.num(plan.counts.nodate)), " without a date")
          : "Drop photos or videos to begin.",
      );
    }

    async function apply() {
      const n = plan.counts.change;
      const ok = await MF.confirm({ title: `Update ${fmt.plural(n, "file")}?`, message: "Only the files' created and modified dates change; the photos and videos themselves aren't touched. You can undo this.", confirm: "Update", iconName: "calendar" });
      if (!ok) return;
      try {
        const res = await MF.busy("Setting file dates…", "exif.datesApply", { paths: drop.paths, options }, (p) => ({ ratio: p.total ? p.done / p.total : null, left: p.phase === "read" ? "Reading dates" : "Writing dates" }));
        const note = res.birthUnsupported ? " (created dates can only be set on macOS)" : "";
        replace(result, undoCallout(res.failures.length ? "amber" : "green", h("span", h("b", `${fmt.plural(res.changed, "file")} updated${note}.`), res.failures.length ? ` ${res.failures.length} failed: ${res.failures.slice(0, 2).map((f) => `${fmt.base(f.path)} (${f.error})`).join(", ")}` : ""), res.historyId, () => refresh()));
        MF.toast("File dates updated", { kind: "success" });
        refresh();
      } catch (err) {
        MF.fail(err);
      }
    }

    update();
    return {
      el,
      setPaths(paths) {
        drop.set(paths);
      },
    };
  }
})();

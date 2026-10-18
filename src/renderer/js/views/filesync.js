/* FileSync */
(function () {
  "use strict";

  const { h, icon, fmt, api, replace } = MF;

  const OPS = {
    copy: { label: "Copy", color: "var(--accent)", badge: "accent" },
    replace: { label: "Replace", color: "var(--amber)", badge: "amber" },
    mkdir: { label: "New folder", color: "var(--blue)", badge: "blue" },
    link: { label: "Link", color: "var(--blue)", badge: "blue" },
    touch: { label: "Fix dates", color: "var(--teal)", badge: "green" },
    remove: { label: "To Trash", color: "var(--red)", badge: "red" },
  };
  const REASON = { size: "size differs", content: "contents differ", type: "file ↔ folder", dates: "dates differ", extra: "not in reference", elsewhere: "lives on another target" };

  MF.views.filesync = {
    title: "FileSync",
    subtitle: "Make other folders or drives exact clones of a reference: same files, same EXIF, same dates.",
    mount() {
      const settings = MF.settings || {};
      const state = {
        mode: "direct",
        wantSplit: false, // chosen before there were two targets
        scope: "all",
        options: { mirror: false, verify: "quick", intoSubfolder: false, strategy: "balance", avoidAppleDouble: true, removeMode: "trash", includeAll: Boolean(settings.includeAll), assignments: {} },
        tree: null, // reference children for the picker
        children: new Map(), // rel -> children
        open: new Set(),
        selected: new Set(),
        plan: null,
      };

      // ----- Inputs ---------------------------------------------------------
      const refDrop = MF.DropZone({ label: "Reference", step: 1, hint: "folder (or one file)", accept: "any", title: "Drop the reference folder", subtitle: "The original. It is only read, never changed", glyph: "folder", onChange: () => { state.options.assignments = {}; state.selected.clear(); state.tree = null; inputsChanged(); } });
      const tgtDrop = MF.DropZone({ label: "Targets", step: 2, hint: "one or more folders", accept: "folder", multiple: true, title: "Drop the target folders", subtitle: "Folders or drives that should become clones", moreTitle: "Add another target", glyph: "disk", onChange: () => { state.options.assignments = {}; inputsChanged(); } });

      const modeSeg = MF.Segmented({
        big: true,
        value: state.mode,
        options: [
          { value: "direct", label: "Direct clone", icon: "clone", title: "Every target gets a full copy" },
          { value: "split", label: "Split clone", icon: "split", title: "Top-level items are shared out across the targets" },
        ],
        onChange: (v) => { state.mode = v; state.wantSplit = v === "split"; state.options.assignments = {}; inputsChanged(); },
      });
      const scopeSeg = MF.Segmented({
        big: true,
        value: state.scope,
        options: [
          { value: "all", label: "Clone all", icon: "layers" },
          { value: "partial", label: "Choose items", icon: "list" },
        ],
        onChange: (v) => { state.scope = v; inputsChanged(); if (v === "partial") loadTree(); },
      });
      const modeHelp = h("div.muted.small", { style: { marginTop: "8px" } });
      const mirrorOpt = MF.Option({ title: "Remove what the reference doesn't have", desc: "Items in a target that aren't in the reference are removed, making it an exact mirror. A drive's own system folders are never touched.", checked: false, onChange: (v) => { state.options.mirror = v; inputsChanged(); } });
      const verifyOpt = MF.Option({ title: "Compare contents byte by byte", desc: "Slower. Otherwise files with the same size and date count as identical.", checked: false, onChange: (v) => { state.options.verify = v ? "thorough" : "quick"; inputsChanged(); } });
      const subOpt = MF.Option({ title: "Put the clone in a subfolder", desc: "Creates a folder named after the reference inside each target, instead of using the target folder itself.", checked: false, onChange: (v) => { state.options.intoSubfolder = v; inputsChanged(); } });
      const strategySeg = MF.Segmented({
        value: state.options.strategy,
        options: [
          { value: "balance", label: "Balance free space" },
          { value: "fill", label: "Fill in order" },
        ],
        onChange: (v) => { state.options.strategy = v; state.options.assignments = {}; inputsChanged(); },
      });
      const strategyRow = h("div.option", h("span.text", h("div.title", "How to share items out"), h("div.desc", "Items already on a target stay there; new ones go where there's room.")), strategySeg.el);
      const dotOpt = MF.Option({ title: "No “._” files on exFAT drives", desc: "exFAT and FAT drives (a new Samsung T7 or T9 is exFAT) can't store Finder tags, so macOS would add a hidden ._ file next to every copy. Recommended.", checked: true, onChange: (v) => { state.options.avoidAppleDouble = v; inputsChanged(); } });
      const removeSeg = MF.Segmented({
        value: state.options.removeMode,
        options: [
          { value: "trash", label: "Move to Trash" },
          { value: "delete", label: "Delete" },
        ],
        onChange: (v) => { state.options.removeMode = v; inputsChanged(); },
      });
      const removeRow = h("div.option", h("span.text", h("div.title", "Replaced and removed items"), h("div.desc", "On an external drive the Trash keeps using space until it's emptied; Delete frees it right away.")), removeSeg.el);

      const treeBox = h("div.tree");
      const treeCard = h("div.card.hidden", h("div.card-head", h("h3", "Choose what to clone"), h("span.sub", "Tick folders or files. A ticked folder includes everything inside it."), h("div.right", MF.Button("All", { size: "sm", onClick: () => selectAll(true) }), MF.Button("None", { size: "sm", onClick: () => selectAll(false) }))), treeBox);

      const analyzeBtn = MF.Button("Analyze", { kind: "primary", size: "lg", iconName: "search", disabled: true, onClick: analyze });
      const out = h("div.stack");
      const summary = h("div.summary", "Choose a reference and at least one target.");
      const runBtn = MF.Button("Start sync", { kind: "primary", size: "lg", iconName: "sync", disabled: true, onClick: run });

      const el = h(
        "div.stack",
        h("div.grid2", refDrop.el, tgtDrop.el),
        h(
          "div.card.card-pad",
          h("div.row", { style: { flexWrap: "wrap", gap: "14px", alignItems: "flex-start" } }, h("div", modeSeg.el, modeHelp), h("div", scopeSeg.el), h("span.spacer"), analyzeBtn),
          h("div", { style: { marginTop: "12px", borderTop: "1px solid var(--line)" } }, strategyRow, mirrorOpt.el, removeRow, dotOpt.el, verifyOpt.el, subOpt.el),
        ),
        treeCard,
        out,
        h("div.actionbar", summary, h("span.spacer"), runBtn),
      );

      function inputsChanged() {
        state.plan = null;
        replace(out);
        const targets = tgtDrop.paths.length;
        modeSeg.disable("split", targets < 2, targets < 2 ? "Add at least two targets to split" : "");
        if (targets < 2 && state.mode === "split") {
          state.mode = "direct";
          modeSeg.set("direct");
        } else if (targets >= 2 && state.wantSplit && state.mode !== "split") {
          state.mode = "split";
          modeSeg.set("split");
        }
        strategyRow.classList.toggle("hidden", state.mode !== "split");
        replace(
          modeHelp,
          state.mode === "split"
            ? `The reference's top-level items are shared across ${targets} targets; each item stays whole.`
            : targets > 1
              ? `Each of the ${targets} targets gets a complete, exact copy.`
              : "The target gets a complete, exact copy.",
        );
        treeCard.classList.toggle("hidden", state.scope !== "partial" || !refDrop.paths.length);
        if (state.scope === "partial" && refDrop.paths.length && !state.tree) loadTree();
        analyzeBtn.disabled = !(refDrop.paths.length && targets && (state.scope === "all" || state.selected.size));
        update();
      }

      // ----- Partial selection tree ----------------------------------------
      async function loadTree() {
        if (!refDrop.paths.length) return;
        replace(treeBox, h("div.muted.small", { style: { padding: "14px" } }, "Reading the reference…"));
        try {
          state.tree = await api.run("sync.tree", { reference: refDrop.paths[0], options: { includeAll: state.options.includeAll } });
          if (state.tree.singleFile) {
            replace(treeBox, h("div.muted.small", { style: { padding: "14px" } }, "The reference is a single file, so it is cloned as a whole."));
            return;
          }
          state.children.set("", state.tree.children);
          drawTree();
        } catch (err) {
          replace(treeBox, MF.Callout("red", err.message));
        }
      }

      function stateOf(rel) {
        let p = rel;
        while (true) {
          if (state.selected.has(p)) return "on";
          const i = p.lastIndexOf("/");
          if (i < 0) break;
          p = p.slice(0, i);
        }
        for (const s of state.selected) if (s.startsWith(`${rel}/`)) return "mixed";
        return "off";
      }

      function toggle(node) {
        const st = stateOf(node.rel);
        if (st !== "on") {
          for (const s of [...state.selected]) if (s.startsWith(`${node.rel}/`)) state.selected.delete(s);
          state.selected.add(node.rel);
        } else if (state.selected.has(node.rel)) {
          state.selected.delete(node.rel);
        } else {
          // An ancestor is ticked: tick its other children instead, down to this node.
          const parts = node.rel.split("/");
          let anc = null;
          for (let i = 1; i < parts.length; i++) {
            const p = parts.slice(0, i).join("/");
            if (state.selected.has(p)) {
              anc = p;
              break;
            }
          }
          if (anc) {
            state.selected.delete(anc);
            let cur = anc;
            const depth = anc.split("/").length;
            for (let i = depth; i < parts.length; i++) {
              const next = parts.slice(0, i + 1).join("/");
              for (const child of state.children.get(cur) || []) if (child.rel !== next) state.selected.add(child.rel);
              cur = next;
            }
          }
        }
        drawTree();
        inputsChanged();
      }

      function selectAll(on) {
        state.selected.clear();
        if (on) for (const c of state.children.get("") || []) state.selected.add(c.rel);
        drawTree();
        inputsChanged();
      }

      async function expand(node) {
        if (state.open.has(node.rel)) state.open.delete(node.rel);
        else {
          state.open.add(node.rel);
          if (!state.children.has(node.rel)) {
            try {
              state.children.set(node.rel, await api.run("sync.children", { reference: refDrop.paths[0], rel: node.rel, options: { includeAll: state.options.includeAll } }));
            } catch (err) {
              MF.fail(err);
            }
          }
        }
        drawTree();
      }

      function drawTree() {
        const rows = [];
        const walk = (rel, depth) => {
          for (const node of state.children.get(rel) || []) {
            const st = stateOf(node.rel);
            const open = state.open.has(node.rel);
            rows.push(
              h(
                "div.tnode",
                { style: { paddingLeft: `${12 + depth * 20}px` } },
                node.hasChildren ? h(`button.tw${open ? ".open" : ""}`, { type: "button", on: { click: () => expand(node) } }, icon("chevron")) : h("span", { style: { width: "18px" } }),
                h(`span.cb.${st}`, { attrs: { role: "checkbox", "aria-checked": st === "on" ? "true" : st === "mixed" ? "mixed" : "false" }, tabIndex: 0, on: { click: () => toggle(node), keydown: (e) => (e.key === " " || e.key === "Enter") && (e.preventDefault(), toggle(node)) } }, st === "on" ? icon("check") : null),
                h(`span.ic${node.kind === "dir" ? "" : ".file"}`, icon(node.kind === "dir" ? "folder" : "file")),
                h("span.nm", { on: { click: () => toggle(node) } }, node.name),
                h("span.sz", node.kind === "dir" ? `${fmt.plural(node.count, "item")} · ${fmt.size(node.size)}` : fmt.size(node.size)),
              ),
            );
            if (open) walk(node.rel, depth + 1);
          }
        };
        walk("", 0);
        replace(treeBox, rows.length ? rows : h("div.muted.small", { style: { padding: "14px" } }, "The reference folder is empty."));
      }

      // ----- Plan ----------------------------------------------------------
      async function analyze() {
        try {
          state.plan = await MF.busy("Analyzing…", "sync.analyze", payload(), (p) => {
            if (p.phase === "scan-reference") return { label: "Reading the reference…", left: `${fmt.num(p.scanned)} items` };
            if (p.phase === "scan-target") return { label: `Reading ${p.target}…`, left: `${fmt.num(p.scanned)} items` };
            if (p.phase === "compare") return { label: "Comparing contents…", ratio: p.totalBytes ? p.doneBytes / p.totalBytes : null, left: `${fmt.size(p.doneBytes)} of ${fmt.size(p.totalBytes)}`, current: p.current };
            return {};
          });
          renderPlan();
        } catch (err) {
          MF.fail(err);
        }
        update();
      }

      function payload() {
        return {
          reference: refDrop.paths[0],
          targets: tgtDrop.paths,
          mode: state.mode,
          selection: state.scope === "partial" ? [...state.selected] : null,
          options: state.options,
        };
      }

      function driveBadges(v) {
        if (!v) return null;
        const parts = [];
        if (v.external) parts.push(h("span.badge.blue", icon("disk"), v.model || v.name));
        parts.push(h("span.badge", v.fsLabel || "Unknown format"));
        if (v.external) parts.push(h("span.badge", `External${v.protocol ? ` · ${v.protocol}` : ""}`));
        if (v.solidState === true) parts.push(h("span.badge", "SSD"));
        if (v.solidState === false) parts.push(h("span.badge", "Hard disk"));
        if (v.writable === false) parts.push(h("span.badge.red", "Read-only"));
        return h("div.chips", { style: { marginTop: "12px", gap: "6px" } }, parts);
      }

      async function eject(r, button) {
        try {
          await MF.withSpinner(button, () => api.run("sync.eject", { path: r.path }));
          MF.toast(`${r.volume.name} ejected`, { kind: "success", detail: "It's safe to unplug it now." });
          button.disabled = true;
          replace(button, icon("check"), h("span", "Ejected"));
        } catch (err) {
          MF.fail(err, `Couldn't eject ${r.volume.name}`);
        }
      }

      function opChips(t) {
        const s = t.stats;
        const chip = (op, n, extra) => (n ? h("span.opchip", h("span.dot", { style: { background: OPS[op].color } }), h("b", fmt.num(n)), ` ${OPS[op].label.toLowerCase()}${extra ? ` · ${extra}` : ""}`) : null);
        const any = s.copy + s.replace + s.mkdir + s.link + s.touch + s.remove;
        return h(
          "div.opchips",
          chip("copy", s.copy, fmt.size(s.copyBytes)),
          chip("replace", s.replace, fmt.size(s.replaceBytes)),
          chip("mkdir", s.mkdir),
          chip("link", s.link),
          chip("touch", s.touch),
          chip("remove", s.remove, fmt.size(s.removeBytes)),
          s.blocked ? h("span.opchip", h("span.dot", { style: { background: "var(--red)" } }), h("b", fmt.num(s.blocked)), " can't be copied") : null,
          h("span.opchip", h("span.dot", { style: { background: "var(--green)" } }), h("b", fmt.num(s.unchanged)), " already identical"),
          any ? null : h("span.badge.green", icon("check"), "Already an exact clone"),
        );
      }

      function actionsTable(t) {
        return MF.VirtualTable({
          maxHeight: 320,
          rows: t.actions,
          columns: [
            { label: "Action", width: "110px", render: (a) => (a.blocked ? h("span.badge.red", { title: a.blocked }, "Skipped") : h(`span.badge.${OPS[a.op].badge}`, OPS[a.op].label)) },
            { label: "Item", width: "minmax(240px, 2fr)", render: (a) => MF.PathCell(a.rel, a.kind), title: (a) => a.rel || "(the folder itself)" },
            { label: "Size", width: "100px", align: "right", render: (a) => (a.kind === "file" || a.op === "remove" ? fmt.size(a.size) : "") },
            { label: "Why", width: "minmax(140px, 1fr)", render: (a) => (a.blocked ? h("span", { style: { color: "var(--red)" } }, a.blocked) : a.reason ? h("span.muted", REASON[a.reason] || a.reason) : "") },
          ],
        });
      }

      function targetPlanCard(t) {
        const box = h("div");
        let open = false;
        const btn = MF.Button(`Show all ${fmt.num(t.actions.length)} actions`, {
          size: "sm",
          iconName: "list",
          disabled: !t.actions.length,
          onClick: () => {
            open = !open;
            replace(box, open ? actionsTable(t).el : null);
            replace(btn.querySelector("span"), open ? "Hide actions" : `Show all ${fmt.num(t.actions.length)} actions`);
          },
        });
        const units = state.plan.mode === "split" ? state.plan.units.filter((u) => u.targets.includes(t.index)) : null;
        return h(
          "div.card",
          h(
            "div.tcard",
            h(
              "div.top",
              h("div.disk", icon("disk")),
              h("div", { style: { minWidth: "0", flex: "1" } }, h("div.tn", t.name), h("div.tp", { title: t.root }, t.root)),
              t.blockedReason ? h("span.badge.red", icon("alert"), "Can't write") : t.enough ? (t.inSync ? h("span.badge.green", icon("check"), "In sync") : h("span.badge.accent", `Needs ${fmt.size(t.needBytes)}`)) : h("span.badge.red", icon("alert"), "Not enough space"),
            ),
            driveBadges(t.volume),
            MF.SpaceBar({ total: t.space.total, free: t.space.free, add: t.needBytes }),
            opChips(t),
            t.blockedReason ? h("div", { style: { marginTop: "12px" } }, MF.Callout("red", t.blockedReason)) : null,
            t.warnings.map((w) => h("div", { style: { marginTop: "10px" } }, MF.Callout("amber", w))),
            t.info ? h("div", { style: { marginTop: "10px" } }, MF.Callout("blue", t.info)) : null,
            units ? h("div.small.muted", { style: { marginTop: "10px" } }, units.length ? `Holds: ${units.map((u) => u.name).join(", ")}` : "Nothing assigned to this target.") : null,
            h("div.row", { style: { marginTop: "12px" } }, h("span.spacer"), btn),
          ),
          box,
        );
      }

      function assignmentCard(plan) {
        const rows = plan.units.map((u) => {
          const select = h(
            "select.select",
            {
              on: {
                change: () => {
                  state.options.assignments[u.rel] = Number(select.value);
                  analyze();
                },
              },
            },
            plan.targets.map((t) => h("option", { value: String(t.index), selected: u.targets[0] === t.index }, t.name)),
          );
          return h("div.tnode", { style: { paddingLeft: "16px", height: "38px" } }, h(`span.ic${u.kind === "dir" ? "" : ".file"}`, icon(u.kind === "dir" ? "folder" : "file")), h("span.nm", u.name), h("span.sz", { style: { marginRight: "12px" } }, fmt.size(u.bytes)), select);
        });
        return h("div.card", h("div.card-head", h("h3", "Where each item goes"), h("span.sub", "Change a destination and the plan updates.")), h("div.tree", { style: { maxHeight: "300px" } }, rows));
      }

      function renderPlan() {
        const plan = state.plan;
        if (!plan) return replace(out);
        const totalNeed = plan.targets.reduce((s, t) => s + t.needBytes, 0);
        replace(
          out,
          MF.Section("Plan", `${plan.mode === "split" ? "Split clone" : "Direct clone"} of ${plan.reference.name}${plan.partial ? " (chosen items)" : ""} · ${fmt.size(plan.reference.size)} in ${fmt.plural(plan.reference.files, "file")}`),
          plan.inSync ? h("div.verdict.good", h("div.big-icon", icon("check")), h("div", h("h3", "Everything is already in sync"), h("p", "Every target is an exact clone of the reference. Nothing to do."))) : null,
          plan.notes.map((n) => MF.Callout("amber", n)),
          plan.allEnough ? null : MF.Callout("red", h("b", "Some targets don't have enough free space. "), "Free up space, choose fewer items, or use a split clone across more drives."),
          plan.options.mirror && plan.targets.some((t) => t.stats.remove)
            ? MF.Callout("amber", h("b", "Mirror is on: "), `${fmt.plural(plan.targets.reduce((s, t) => s + t.stats.remove, 0), "item")} ${plan.options.removeMode === "delete" ? "will be deleted for good." : "will go to the Trash. You can put them back from there."}`)
            : null,
          plan.mode === "split" ? assignmentCard(plan) : null,
          h("div.report-hero", plan.targets.map(targetPlanCard)),
          totalNeed ? h("div.small.muted", "Same-disk copies on APFS are cloned and take no extra space, so actual usage can be lower than shown.") : null,
        );
      }

      function update() {
        const plan = state.plan;
        const work = plan ? plan.targets.reduce((s, t) => s + t.actions.length, 0) : 0;
        runBtn.disabled = !plan || !work || !plan.allEnough;
        replace(
          summary,
          plan
            ? h("span", h("b", fmt.num(work)), " actions · ", h("b", fmt.size(plan.targets.reduce((s, t) => s + t.needBytes, 0))), ` to copy to ${fmt.plural(plan.targets.length, "target")}`)
            : refDrop.paths.length && tgtDrop.paths.length
              ? "Press Analyze to see exactly what will happen."
              : "Choose a reference and at least one target.",
        );
      }

      // ----- Run -----------------------------------------------------------
      async function run() {
        const plan = state.plan;
        const removing = plan.targets.reduce((s, t) => s + t.stats.remove + t.stats.replace, 0);
        const ok = await MF.confirm({
          title: "Start syncing?",
          message: `${fmt.size(plan.targets.reduce((s, t) => s + t.needBytes, 0))} will be copied to ${fmt.plural(plan.targets.length, "target")}.${removing ? ` ${fmt.plural(removing, "item")} that get replaced or removed ${plan.options.removeMode === "delete" ? "are deleted for good" : "go to the Trash"}.` : ""} The reference is only read. Keep the drives plugged in until it finishes; your Mac won't go to sleep meanwhile.`,
          confirm: "Start",
          iconName: "sync",
        });
        if (!ok) return;
        state.lastRemoveMode = plan.options.removeMode;
        let t0 = null;
        try {
          const res = await MF.busy("Syncing…", "sync.run", { planId: plan.id }, (p) => {
            if (!t0 && p.doneBytes > 0) t0 = { time: Date.now(), bytes: p.doneBytes };
            const elapsed = t0 ? (Date.now() - t0.time) / 1000 : 0;
            const rate = elapsed > 1 ? (p.doneBytes - t0.bytes) / elapsed : 0;
            const eta = rate > 0 ? ((p.totalBytes - p.doneBytes) / rate) * 1000 : null;
            const labels = { remove: "Moving old items to the Trash", copy: "Copying", dates: "Setting dates", verify: "Verifying" };
            return {
              label: p.phase === "copy" && p.active && p.active.length > 1 ? `Copying ${p.active.length} files at once${p.target ? ` · ${p.target}` : ""}` : `${labels[p.phase] || "Working"}${p.target ? ` · ${p.target}` : ""}`,
              ratio: p.totalBytes ? p.doneBytes / p.totalBytes : p.phase === "verify" ? 1 : null,
              left: p.totalBytes ? `${fmt.size(p.doneBytes)} of ${fmt.size(p.totalBytes)} · ${fmt.num(p.doneFiles)} of ${fmt.num(p.totalFiles)} files finished${p.active && p.active.length > 1 ? " (the rest are in progress or waiting)" : ""}` : "",
              right: rate ? `${fmt.size(rate)}/s${eta !== null ? ` · ${fmt.duration(eta)} left` : ""}` : "",
              current: p.current,
              active: p.phase === "copy" ? p.active : null,
            };
          });
          renderReport(res);
          state.plan = null;
          MF.toast("Sync finished", { kind: res.errors ? "warn" : "success", detail: `${fmt.size(res.bytesWritten)} written` });
        } catch (err) {
          MF.fail(err);
          if (err.cancelled) inputsChanged();
        }
        update();
      }

      function usageBars(r) {
        const b = r.spaceBefore;
        const a = r.spaceAfter;
        if (!b.total || b.free === null || a.free === null) return null;
        const usedB = b.total - b.free;
        const usedA = a.total - a.free;
        const pct = (n, total) => `${Math.max(0.5, (n / total) * 100)}%`;
        const before = h("span", { style: { width: pct(usedB, b.total), background: "color-mix(in srgb, var(--ink-2) 40%, transparent)" } });
        const afterBase = h("span", { style: { width: pct(Math.min(usedB, usedA), a.total), background: "color-mix(in srgb, var(--ink-2) 40%, transparent)" } });
        const afterAdd = h("span", { style: { width: "0%", background: "linear-gradient(90deg, var(--accent), #9a7bff)", transition: "width .8s var(--ease)" } });
        requestAnimationFrame(() => requestAnimationFrame(() => (afterAdd.style.width = usedA > usedB ? pct(usedA - usedB, a.total) : "0%")));
        return h(
          "div.compare-bars",
          h("span", "Before"),
          h("div.bar", before),
          h("span.num", { style: { textAlign: "right" } }, `${fmt.size(b.free)} free`),
          h("span", "After"),
          h("div.bar", afterBase, afterAdd),
          h("span.num", { style: { textAlign: "right" } }, `${fmt.size(a.free)} free`),
        );
      }

      function renderReport(res) {
        const good = !res.errors && res.targets.every((t) => t.verify && t.verify.mismatches === 0);
        replace(
          out,
          h(
            `div.verdict.${good ? "good" : "warn"}`,
            h("div.big-icon", icon(good ? "check" : "alert")),
            h(
              "div",
              h("h3", good ? "Sync complete · verified" : "Sync finished with some problems"),
              h("p", `${fmt.size(res.bytesWritten)} of files copied to ${fmt.plural(res.targets.length, "target")} in ${fmt.duration(res.elapsedMs)}${res.targets.every((t) => t.cloned || !t.bytesWritten) ? "" : ` · extra space used: about ${fmt.size(Math.max(0, res.targets.filter((t) => !t.cloned).reduce((s, t) => s + (t.spaceUsed || 0), 0)))}`}`),
            ),
            h("div.actions", MF.Button("Analyze again", { iconName: "refresh", onClick: analyze })),
          ),
          MF.Section("Space report", "How much more room each target uses now"),
          h(
            "div.report-hero",
            res.targets.map((r) => {
              const used = r.spaceUsed;
              // Free space is for the whole disk, so other apps' writes show up too; small numbers are noise.
              const noisy = used === null || Math.abs(used) < 1024 * 1024;
              const refName = res.reference ? res.reference.name : "the reference";
              const headline = r.cloned
                ? h("div.used-big", fmt.size(r.bytesWritten), " ", h("small", `· shares space with ${refName}`))
                : h("div.used-big", used === null ? "—" : noisy && r.bytesWritten ? `≈ ${fmt.size(r.bytesWritten)}` : `${used >= 0 ? "+" : "−"}${fmt.size(Math.abs(used))}`, " ", h("small", "extra space used"));
              const note = r.cloned
                ? `On the same APFS disk, copies are clones: they take no extra space until one of them is changed. Disk free space changed by ${used === null ? "—" : fmt.size(Math.abs(used))} (folder records and other activity on the Mac).`
                : `${fmt.size(r.bytesWritten)} of files copied${noisy && used !== null && r.bytesWritten ? ` · disk free space changed by ${fmt.size(Math.abs(used))}, which also includes other activity on the Mac` : ""}`;
              return h(
                "div.card.tcard",
                h("div.top", h("div.disk", icon("disk")), h("div", { style: { minWidth: "0", flex: "1" } }, h("div.tn", r.name), h("div.tp", { title: r.root }, r.root))),
                h("div", { style: { marginTop: "14px" } }, headline, h("div.small.muted", note)),
                usageBars(r),
                h(
                  "div.opchips",
                  h("span.opchip", h("span.dot", { style: { background: OPS.copy.color } }), h("b", fmt.num(r.copied)), " copied"),
                  r.replaced ? h("span.opchip", h("span.dot", { style: { background: OPS.replace.color } }), h("b", fmt.num(r.replaced)), " replaced") : null,
                  r.created ? h("span.opchip", h("span.dot", { style: { background: OPS.mkdir.color } }), h("b", fmt.num(r.created)), " folders") : null,
                  r.touched ? h("span.opchip", h("span.dot", { style: { background: OPS.touch.color } }), h("b", fmt.num(r.touched)), " dates fixed") : null,
                  r.removed ? h("span.opchip", h("span.dot", { style: { background: OPS.remove.color } }), h("b", fmt.num(r.removed)), state.lastRemoveMode === "delete" ? " deleted" : " to Trash") : null,
                  r.skipped ? h("span.opchip", h("span.dot", { style: { background: "var(--red)" } }), h("b", fmt.num(r.skipped)), " skipped") : null,
                ),
                r.verify && r.verify.mismatches === 0
                  ? h("div", { style: { marginTop: "12px" } }, h("span.badge.green", icon("check"), `Verified: ${fmt.num(r.verify.checked)} items match`))
                  : r.verify
                    ? h("div", { style: { marginTop: "12px" } }, MF.Callout("amber", h("b", `${fmt.num(r.verify.mismatches)} items still differ. `), r.verify.sample.slice(0, 4).join(" · ")))
                    : null,
                r.birthUnsupported ? h("div.small.muted", { style: { marginTop: "8px" } }, "Created dates can only be set on macOS.") : null,
                r.volume && r.volume.ejectable
                  ? h("div.row", { style: { marginTop: "12px" } }, h("span.small.muted", { style: { flex: "1" } }, `${r.volume.name} can be unplugged once it's ejected.`), MF.Button(`Eject ${r.volume.name}`, { size: "sm", iconName: "save", onClick: (e) => eject(r, e.currentTarget) }))
                  : null,
                r.errors.length ? h("div", { style: { marginTop: "10px" } }, MF.Callout("red", h("b", `${fmt.plural(r.errors.length, "problem")}: `), r.errors.slice(0, 5).map((e) => `${e.rel} (${e.error})`).join(" · "))) : null,
              );
            }),
          ),
        );
      }

      inputsChanged();
      return {
        el,
        onShow(params) {
          if (params.mode === "split" || params.mode === "direct") {
            state.wantSplit = params.mode === "split";
            state.mode = params.mode;
            modeSeg.set(params.mode);
            inputsChanged();
          }
          if (params.reference) refDrop.set([params.reference]);
        },
      };
    },
  };
})();

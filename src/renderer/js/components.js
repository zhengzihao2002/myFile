/* myFile renderer components */
(function () {
  "use strict";

  const { h, icon, fmt, api, replace } = MF;
  // Left-to-right mark: keeps the leading "/" in place in right-aligned (rtl-truncated) paths.
  const LRM = String.fromCharCode(0x200e);

  const MEDIA_EXT = ["jpg", "jpeg", "png", "heic", "heif", "avif", "tif", "tiff", "gif", "webp", "bmp", "dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2", "pef", "srw", "psd", "mov", "mp4", "m4v", "3gp", "avi", "mkv", "mts", "m2ts", "webm"];

  // ---------------------------------------------------------------------------
  // Drop zone
  // ---------------------------------------------------------------------------

  const ACCEPT = {
    file: { test: (i) => i.isFile, noun: "a file", dialog: { kind: "file" } },
    media: { test: (i) => i.isFile && Boolean(i.media), noun: "a photo or video", dialog: { kind: "file", filters: [{ name: "Photos & videos", extensions: MEDIA_EXT }, { name: "All files", extensions: ["*"] }] } },
    folder: { test: (i) => i.isDir, noun: "a folder", dialog: { kind: "folder" } },
    any: { test: (i) => i.exists, noun: "a file or folder", dialog: { kind: "any" } },
    "media-or-folder": { test: (i) => i.isDir || Boolean(i.media), noun: "photos, videos or folders", dialog: { kind: "any" } },
    "folder-or-html": { test: (i) => i.isDir || i.isHtml, noun: "a folder or an HTML index", dialog: { kind: "any", filters: [{ name: "Folders or HTML index", extensions: ["html", "htm"] }] } },
  };

  function thumbFor(info) {
    if (info.isDir) return h("div.thumb.folder", icon("folder"));
    if (info.isHtml) return h("div.thumb.html", icon("html"));
    if (info.media === "video") return h("div.thumb.video", icon("video"));
    if (info.media === "image") return h("div.thumb", info.url ? h("img", { src: info.url, alt: "", loading: "lazy", on: { error: (e) => e.target.replaceWith(icon("photo")) } }) : icon("photo"));
    return h("div.thumb", icon("file"));
  }

  function describeInfo(info) {
    if (!info.exists) return "Not found";
    if (info.isDir) {
      const count = info.entries === null || info.entries === undefined ? "Folder" : `Folder · ${fmt.plural(info.entries, "item")}`;
      return info.volume ? `${count} · on ${info.volume.model || info.volume.name} (${info.volume.fsLabel})` : count;
    }
    const kind = info.isHtml ? "HTML index" : info.media === "video" ? "Video" : info.media === "image" ? "Photo" : "File";
    return `${kind} · ${fmt.size(info.size)}`;
  }

  /**
   * MF.DropZone({ label, step, hint, accept, multiple, title, subtitle, glyph, onChange })
   * Files and folders can be dropped, chosen with a click, or pasted as paths.
   */
  MF.DropZone = function DropZone(opts) {
    const accept = ACCEPT[opts.accept || "any"];
    let infos = [];
    const itemsBox = h("div.items");
    const area = h(
      "div.drop-area",
      {
        tabIndex: 0,
        attrs: { role: "button", "aria-label": opts.title },
        on: {
          click: () => browse(),
          keydown: (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              browse();
            }
          },
        },
      },
      h("div.glyph", icon(opts.glyph || "drop")),
      h("div.texts", h("div.t", opts.title), h("div.s", opts.subtitle || "Drop here or click to choose")),
    );
    const root = h(
      "div.drop",
      { tabIndex: -1 },
      opts.label ? h("div.drop-label", opts.step ? h("span.step", String(opts.step)) : null, opts.label, opts.hint ? h("span.hint", opts.hint) : null) : null,
      area,
      itemsBox,
    );

    let depth = 0;
    root.addEventListener("dragenter", (e) => {
      e.preventDefault();
      depth++;
      root.classList.add("over");
    });
    root.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    root.addEventListener("dragleave", () => {
      depth = Math.max(0, depth - 1);
      if (!depth) root.classList.remove("over");
    });
    root.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      depth = 0;
      root.classList.remove("over");
      const paths = [...(e.dataTransfer.files || [])].map((f) => api.pathForFile(f)).filter(Boolean);
      if (!paths.length) {
        const text = e.dataTransfer.getData("text/plain");
        if (text) paths.push(...text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
      }
      add(paths);
    });
    root.addEventListener("paste", (e) => {
      const text = e.clipboardData && e.clipboardData.getData("text/plain");
      if (!text) return;
      e.preventDefault();
      add(text.split(/\r?\n/).map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter((s) => s.startsWith("/")));
    });

    async function browse() {
      const chosen = await api.dialog({ mode: "open", multiple: Boolean(opts.multiple), title: opts.title, ...accept.dialog });
      if (chosen && chosen.length) add(chosen);
    }

    async function add(paths) {
      if (!paths.length) return;
      let found;
      try {
        found = await api.run("paths.inspect", { paths });
      } catch (err) {
        MF.fail(err);
        return;
      }
      const good = found.filter((i) => i.exists && accept.test(i));
      const bad = found.filter((i) => !(i.exists && accept.test(i)));
      if (bad.length) {
        MF.toast(`Please choose ${accept.noun}`, {
          kind: "warn",
          detail: bad.length === 1 ? `${bad[0].name} ${bad[0].exists ? "isn't the right kind of item" : "can't be found"}.` : `${bad.length} items were skipped.`,
        });
      }
      if (!good.length) return;
      if (opts.multiple) {
        const known = new Set(infos.map((i) => i.path));
        infos = infos.concat(good.filter((i) => !known.has(i.path)));
      } else {
        infos = [good[0]];
      }
      render();
      changed();
    }

    function remove(path) {
      infos = infos.filter((i) => i.path !== path);
      render();
      changed();
    }

    function changed() {
      if (opts.onChange) opts.onChange(infos.map((i) => i.path), infos);
    }

    function render() {
      replace(
        itemsBox,
        infos.map((info) =>
          h(
            "div.item",
            { title: info.path },
            thumbFor(info),
            h("div.meta", h("div.name", info.name), h("div.path", LRM + fmt.dir(info.path))),
            h("div.info", describeInfo(info)),
            h("button.btn.ghost.sm.icon.x", { title: "Reveal in Finder", on: { click: () => api.reveal(info.path) } }, icon("reveal")),
            h("button.btn.ghost.sm.icon.x", { title: "Remove", on: { click: () => remove(info.path) } }, icon("x")),
          ),
        ),
      );
      const filled = infos.length > 0;
      root.classList.toggle("compact", filled);
      area.classList.toggle("hidden", filled && !opts.multiple);
      area.querySelector(".t").textContent = filled && opts.multiple ? opts.moreTitle || "Add more" : opts.title;
      if (!filled || !opts.multiple) area.querySelector(".s").textContent = opts.subtitle || "Drop here or click to choose";
      else area.querySelector(".s").textContent = "Drop more here or click to choose";
      if (filled && !opts.multiple) {
        itemsBox.lastChild.insertBefore(
          h("button.btn.sm", { on: { click: () => browse() } }, "Change"),
          itemsBox.lastChild.querySelector(".x"),
        );
      }
    }

    render();
    return {
      el: root,
      get paths() {
        return infos.map((i) => i.path);
      },
      get infos() {
        return infos.slice();
      },
      set: (paths) => {
        infos = [];
        render();
        return add(paths);
      },
      add,
      clear: () => {
        infos = [];
        render();
        changed();
      },
    };
  };

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------

  MF.Segmented = function Segmented({ options, value, onChange, big }) {
    let current = value;
    const buttons = new Map();
    const el = h(`div.seg${big ? ".big" : ""}`, { attrs: { role: "radiogroup" } });
    for (const o of options) {
      const b = h(
        "button",
        {
          type: "button",
          title: o.title || "",
          attrs: { role: "radio" },
          on: {
            click: () => {
              if (o.value === current || b.disabled) return;
              set(o.value);
              if (onChange) onChange(o.value);
            },
          },
        },
        o.icon ? icon(o.icon) : null,
        o.label,
      );
      buttons.set(o.value, b);
      el.appendChild(b);
    }
    function set(v) {
      current = v;
      for (const [val, b] of buttons) {
        b.classList.toggle("on", val === v);
        b.setAttribute("aria-checked", String(val === v));
      }
    }
    set(current);
    return {
      el,
      get value() {
        return current;
      },
      set,
      disable(v, disabled, title) {
        const b = buttons.get(v);
        if (!b) return;
        b.disabled = disabled;
        if (title !== undefined) b.title = title;
      },
    };
  };

  /** "Identical only if these all match: size, modified date, ..." for the Custom compare choice, with a link to Settings. */
  MF.customChecksText = function customChecksText(extra) {
    const c = { size: true, modified: true, created: false, exifDates: true, gps: true, otherMeta: false, contents: false, ...(MF.settings && MF.settings.customCompare) };
    const rows = [["size", "size"], ["modified", "modified date"], ["created", "created date"], ["exifDates", "photo/video dates (EXIF)"], ["gps", "GPS location"], ["otherMeta", "other metadata"], ["contents", "every byte of the contents"]];
    const on = rows.filter(([k]) => c[k] && !(c.contents && ["exifDates", "gps", "otherMeta"].includes(k))).map(([, label]) => label);
    return [
      h("b", "Identical only if these all match: "),
      on.length ? on.join(", ") : "nothing (every pair of files at the same path counts as identical)",
      ". ",
      c.contents ? "Every byte is read, which covers all metadata. " : "Files are not read in full. ",
      extra || null,
      "Change this in ",
      h("a", { href: "#", on: { click: (e) => { e.preventDefault(); MF.go("settings"); } } }, "Settings › Comparing and speed"),
      ".",
    ];
  };

  MF.Option = function Option({ title, desc, checked, onChange, disabled }) {
    const input = h("input", { type: "checkbox", checked: Boolean(checked), disabled: Boolean(disabled), on: { change: () => onChange && onChange(input.checked) } });
    const el = h("label.option", h("span.text", h("div.title", title), desc ? h("div.desc", desc) : null), h("span.switch", input, h("span.track"), h("span.thumb")));
    return {
      el,
      input,
      get checked() {
        return input.checked;
      },
      set(v) {
        input.checked = Boolean(v);
      },
      disable(v) {
        input.disabled = Boolean(v);
        el.style.opacity = v ? "0.55" : "";
      },
    };
  };

  MF.ChipToggle = function ChipToggle({ label, checked, onChange, title, iconName }) {
    let on = Boolean(checked);
    const el = h(
      "button.chip-toggle",
      {
        type: "button",
        title: title || "",
        attrs: { role: "checkbox" },
        on: {
          click: () => {
            set(!on);
            if (onChange) onChange(on);
          },
        },
      },
      h("span.box", icon("check")),
      iconName ? icon(iconName) : null,
      label,
    );
    function set(v) {
      on = Boolean(v);
      el.classList.toggle("on", on);
      el.setAttribute("aria-checked", String(on));
    }
    set(on);
    return {
      el,
      get checked() {
        return on;
      },
      set,
    };
  };

  MF.Button = function Button(label, { kind, iconName, onClick, size, title, disabled } = {}) {
    const classes = ["btn", kind, size].filter(Boolean).join(".");
    const el = h(`button.${classes}`, { type: "button", title: title || "", disabled: Boolean(disabled), on: { click: (e) => onClick && onClick(e) } }, iconName ? icon(iconName) : null, label ? h("span", label) : null);
    return el;
  };

  /** Runs fn while the button shows a spinner (and can't be clicked twice). */
  MF.withSpinner = async function withSpinner(button, fn) {
    const old = [...button.childNodes];
    const label = button.textContent;
    button.disabled = true;
    replace(button, h("span.spin"), label ? h("span", label) : null);
    try {
      return await fn();
    } finally {
      button.disabled = false;
      replace(button, old);
    }
  };

  // ---------------------------------------------------------------------------
  // Virtual table: fixed-height rows, renders only what's visible.
  // ---------------------------------------------------------------------------

  MF.VirtualTable = function VirtualTable({ columns, rows = [], rowHeight = 34, maxHeight = 420, empty = "Nothing to show.", onRowClick = null }) {
    let all = rows;
    let shown = rows;
    let filter = null;
    const cols = columns.map((c) => c.width || "1fr").join(" ");
    const head = h("div.vhead", columns.map((c) => h(`div${c.align === "right" ? ".r" : ""}`, { title: c.label }, c.label)));
    const space = h("div.vspace");
    const body = h("div.vbody", { on: { scroll: () => draw() } }, space);
    const el = h("div.vtable", { "--cols": cols }, head, body);
    body.style.maxHeight = `${maxHeight}px`;

    const pool = new Map();
    function draw() {
      if (!shown.length) {
        space.style.height = "";
        replace(space, h("div.empty-row", empty));
        pool.clear();
        return;
      }
      if (space.firstChild && space.firstChild.classList && space.firstChild.classList.contains("empty-row")) space.firstChild.remove();
      space.style.height = `${shown.length * rowHeight}px`;
      body.style.height = `${Math.min(maxHeight, shown.length * rowHeight)}px`;
      const top = body.scrollTop;
      const view = body.clientHeight || maxHeight;
      const first = Math.max(0, Math.floor(top / rowHeight) - 6);
      const last = Math.min(shown.length, Math.ceil((top + view) / rowHeight) + 6);
      const keep = new Set();
      for (let i = first; i < last; i++) {
        keep.add(i);
        if (pool.has(i)) continue;
        const row = shown[i];
        const r = h(
          "div.vrow",
          { style: { top: `${i * rowHeight}px`, height: `${rowHeight}px`, cursor: onRowClick ? "pointer" : "" }, on: onRowClick ? { click: () => onRowClick(row) } : {} },
          columns.map((c) => {
            const v = c.render ? c.render(row, i) : row[c.key];
            const cell = h(`div${c.align === "right" ? ".r" : ""}`);
            if (v instanceof Node) cell.appendChild(v);
            else cell.textContent = v === null || v === undefined ? "" : String(v);
            if (c.title) cell.title = c.title(row);
            else if (typeof v === "string") cell.title = v;
            return cell;
          }),
        );
        pool.set(i, r);
        space.appendChild(r);
      }
      for (const [i, r] of pool) {
        if (!keep.has(i)) {
          r.remove();
          pool.delete(i);
        }
      }
    }
    function reset() {
      for (const r of pool.values()) r.remove();
      pool.clear();
      shown = filter ? all.filter(filter) : all;
      body.scrollTop = 0;
      draw();
    }
    requestAnimationFrame(draw);
    new ResizeObserver(() => draw()).observe(body);
    reset();
    return {
      el,
      setRows(r) {
        all = r || [];
        reset();
      },
      setFilter(fn) {
        filter = fn;
        reset();
      },
      get count() {
        return shown.length;
      },
    };
  };

  MF.Tabs = function Tabs({ tabs, value, onChange }) {
    let current = value;
    const el = h("div.tabs", { attrs: { role: "tablist" } });
    const map = new Map();
    for (const t of tabs) {
      const count = h("span.count", fmt.num(t.count || 0));
      const b = h("button.tab", { type: "button", attrs: { role: "tab" }, on: { click: () => { set(t.id); if (onChange) onChange(t.id); } } }, t.label, count);
      map.set(t.id, { b, count });
      el.appendChild(b);
    }
    function set(id) {
      current = id;
      for (const [k, { b }] of map) b.classList.toggle("on", k === id);
    }
    set(current);
    return {
      el,
      set,
      get value() {
        return current;
      },
      setCount(id, n) {
        const t = map.get(id);
        if (t) t.count.textContent = fmt.num(n);
      },
    };
  };

  MF.Stat = function Stat({ label, value, sub, iconName, tone }) {
    return h(`div.stat${tone ? `.${tone}` : ""}`, h("div.k", iconName ? icon(iconName) : null, label), h("div.v", value), sub ? h("div.s", sub) : null);
  };

  MF.Empty = function Empty({ iconName = "sparkles", title, text }) {
    return h("div.empty", h("div.eglyph", icon(iconName)), title ? h("h4", title) : null, text ? h("p", text) : null);
  };

  MF.Callout = function Callout(kind, ...children) {
    const iconName = { amber: "alert", red: "alert", green: "check", blue: "info" }[kind] || "info";
    return h(`div.callout${kind && kind !== "blue" ? `.${kind}` : ""}`, icon(iconName), h("div", ...children));
  };

  MF.Change = function Change(oldText, newText) {
    if (!oldText && !newText) return h("span.faint", "—");
    if (oldText === newText) return h("span", newText || "—");
    return h("span.arrow-change", h("span.old", oldText || "none"), icon("arrow"), h("span.new", newText || "none"));
  };

  /** Old → new date, to the minute; the exact values are in the tooltip. */
  MF.DateChange = function DateChange(oldMs, newMs) {
    const el = MF.Change(fmt.date(oldMs, { seconds: false }), fmt.date(newMs, { seconds: false }));
    el.title = `${fmt.date(oldMs)}  →  ${fmt.date(newMs)}`;
    if (fmt.date(oldMs, { seconds: false }) === fmt.date(newMs, { seconds: false })) {
      el.textContent = "";
      el.append(h("span", { title: el.title }, `${fmt.date(newMs, { seconds: false })} (seconds differ)`));
    }
    return el;
  };

  MF.PathCell = function PathCell(rel, kind) {
    const i = rel.lastIndexOf("/");
    return h(
      "span.cell-path",
      icon(kind === "dir" ? "folder" : kind === "link" ? "external" : "file"),
      h("span", i > 0 ? h("span.dir", `${rel.slice(0, i + 1)}`) : null, i > 0 ? rel.slice(i + 1) : rel || "(the folder itself)"),
    );
  };

  /** Disk usage bar: used, being added, free. */
  MF.SpaceBar = function SpaceBar({ total, free, add }) {
    if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0) {
      return h("div.spacebar", h("div.legend", h("span", "Free space unknown for this disk")));
    }
    const used = total - free;
    const over = add > free;
    const pct = (n) => `${Math.max(0, Math.min(100, (n / total) * 100))}%`;
    const usedEl = h("span.used", { style: { width: "0%" } });
    const addEl = h(`span.add${over ? ".over" : ""}`, { style: { width: "0%" } });
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        usedEl.style.width = pct(used);
        addEl.style.width = pct(Math.min(add, free));
      }),
    );
    return h(
      "div.spacebar",
      h("div.bar", usedEl, addEl),
      h(
        "div.legend",
        h("span", h("i", { style: { background: "color-mix(in srgb, var(--ink-2) 35%, transparent)" } }), `Used ${fmt.size(used)}`),
        h("span", h("i", { style: { background: over ? "var(--red)" : "var(--accent)" } }), `${over ? "Needs" : "Adds up to"} ${fmt.size(add)}`),
        h("span", h("i", { style: { background: "var(--surface-3)", border: "1px solid var(--line-strong)" } }), `Free ${fmt.size(free)} of ${fmt.size(total)}`),
      ),
    );
  };

  MF.Section = function Section(title, sub, ...right) {
    return h("div.section-title", h("h2", title), sub ? h("span.sub", sub) : null, right.length ? h("div.right", ...right) : null);
  };
})();

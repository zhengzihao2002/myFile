/* myFile renderer core: element builder, icons, formatting, API, toasts, dialogs. */
(function () {
  "use strict";

  const MF = (window.MF = window.MF || {});
  MF.views = {};

  // ---------------------------------------------------------------------------
  // Elements
  // ---------------------------------------------------------------------------

  /**
   * h("div.card.pad", { on: { click }, title: "x" }, child, [children], "text")
   * Props: class, style (object), on (events), dataset, html, attrs, plus any
   * DOM property (value, checked, disabled, type, title ...).
   */
  function h(spec, props, ...children) {
    if (props === null || typeof props !== "object" || props instanceof Node || Array.isArray(props)) {
      if (props !== undefined && props !== null) children.unshift(props);
      props = {};
    }
    const [tag, ...rest] = spec.split(/(?=[.#])/);
    const el = tag === "svg" ? document.createElementNS("http://www.w3.org/2000/svg", "svg") : document.createElement(tag || "div");
    for (const part of rest) {
      if (part[0] === ".") el.classList.add(part.slice(1));
      else if (part[0] === "#") el.id = part.slice(1);
    }
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") String(value).split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
      else if (key === "style") Object.assign(el.style, value);
      else if (key === "on") for (const [ev, fn] of Object.entries(value)) el.addEventListener(ev, fn);
      else if (key === "dataset") Object.assign(el.dataset, value);
      else if (key === "html") el.innerHTML = value;
      else if (key === "attrs") for (const [a, v] of Object.entries(value)) el.setAttribute(a, v);
      else if (key.startsWith("--")) el.style.setProperty(key, value);
      else el[key] = value;
    }
    append(el, children);
    return el;
  }

  function append(el, children) {
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  }

  function replace(el, ...children) {
    clear(el);
    return append(el, children);
  }

  MF.h = h;
  MF.append = append;
  MF.clear = clear;
  MF.replace = replace;

  // ---------------------------------------------------------------------------
  // Icons (24×24 line icons)
  // ---------------------------------------------------------------------------

  const ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
    photo: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="9.5" r="1.8"/><path d="m21 15.5-4.6-4.6a1.2 1.2 0 0 0-1.7 0L5.5 20"/>',
    wand: '<path d="m15 4 1.2 2.8L19 8l-2.8 1.2L15 12l-1.2-2.8L11 8l2.8-1.2z"/><path d="m4 20 9-9"/><path d="M5 3v3M3.5 4.5h3M19 15v3M17.5 16.5h3"/>',
    folder: '<path d="M3 7.5a2 2 0 0 1 2-2h3.6l2 2.4H19a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    compare: '<rect x="3" y="4" width="7" height="16" rx="2"/><rect x="14" y="4" width="7" height="16" rx="2"/><path d="M6.5 9h0M6.5 12h0M17.5 9h0M17.5 15h0"/>',
    clockfix: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    html: '<path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5"/><path d="m10 12-2 2.5 2 2.5M14 12l2 2.5-2 2.5"/>',
    sync: '<path d="M20 11a8 8 0 0 0-14.3-4.6L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.6L20 16"/><path d="M20 20v-4h-4"/>',
    history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3 4v4.5h4.5"/><path d="M12 8v4.5l3 1.8"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    alert: '<path d="M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h0"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8h0"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    swap: '<path d="M7 4 3 8l4 4"/><path d="M3 8h14"/><path d="m17 20 4-4-4-4"/><path d="M21 16H7"/>',
    reveal: '<path d="M3 7.5a2 2 0 0 1 2-2h3.6l2 2.4H19a2 2 0 0 1 2 2V12"/><path d="M3 7.5V17a2 2 0 0 0 2 2h6"/><circle cx="17" cy="17" r="3"/><path d="m21.5 21.5-2.4-2.4"/>',
    pin: '<path d="M12 21s-6.5-5.6-6.5-11A6.5 6.5 0 0 1 18.5 10c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
    camera: '<path d="M4 8.5A2.5 2.5 0 0 1 6.5 6H8l1.5-2h5L16 6h1.5A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z"/><circle cx="12" cy="12.5" r="3.5"/>',
    video: '<rect x="3" y="5.5" width="13" height="13" rx="2.5"/><path d="m16 10 5-3v10l-5-3"/>',
    file: '<path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    down: '<path d="m5 9 7 7 7-7"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    save: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
    drop: '<path d="M12 3v11"/><path d="m7.5 9.5 4.5 4.5 4.5-4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
    disk: '<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M5 13 7.5 5h9L19 13"/><path d="M7 16.5h0M10 16.5h0"/>',
    sparkles: '<path d="m12 3 1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15v4M17 17h4"/>',
    external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
    split: '<path d="M12 3v6"/><path d="M12 9 6 15v6M12 9l6 6v6"/>',
    clone: '<rect x="3" y="3" width="11" height="11" rx="2.5"/><rect x="10" y="10" width="11" height="11" rx="2.5"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
    leaf: '<path d="M5 19c0-8 5-13 15-14-1 10-6 15-14 15"/><path d="M5 19 13 11"/>',
    play: '<path d="M7 4.5v15l12-7.5z"/>',
    tag: '<path d="M3 11.5V4a1 1 0 0 1 1-1h7.5L21 12.5 12.5 21z"/><circle cx="7.5" cy="7.5" r="1.4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    gauge: '<path d="M4.2 17a9 9 0 1 1 15.6 0"/><path d="m12 13 4-4"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h0M3.5 12h0M3.5 18h0"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  };

  function icon(name, cls) {
    const span = document.createElement("span");
    span.innerHTML = `<svg class="i${cls ? ` ${cls}` : ""}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.info}</svg>`;
    return span.firstChild;
  }
  MF.icon = icon;
  MF.ICONS = ICONS;

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------

  const pad = (n) => String(n).padStart(2, "0");
  const fmt = {
    size(bytes) {
      if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
      const neg = bytes < 0;
      let n = Math.abs(bytes);
      if (n < 1000) return `${neg ? "-" : ""}${n} B`;
      const units = ["KB", "MB", "GB", "TB", "PB"];
      let i = -1;
      do {
        n /= 1000;
        i++;
      } while (n >= 1000 && i < units.length - 1);
      return `${neg ? "-" : ""}${n.toFixed(n < 10 ? 2 : n < 100 ? 1 : 0)} ${units[i]}`;
    },
    num(n) {
      return Number(n || 0).toLocaleString();
    },
    date(ms, { seconds = true } = {}) {
      if (!Number.isFinite(ms) || ms <= 0) return "—";
      const d = new Date(ms);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ""}`;
    },
    nice(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return "—";
      return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
    },
    ago(ms) {
      const s = (Date.now() - ms) / 1000;
      if (s < 45) return "just now";
      if (s < 3600) return `${Math.round(s / 60)} min ago`;
      if (s < 86400) return `${Math.round(s / 3600)} h ago`;
      if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
      return new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" });
    },
    duration(ms) {
      if (!Number.isFinite(ms)) return "—";
      const s = Math.round(ms / 1000);
      if (s < 60) return `${s}s`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m ${pad(s % 60)}s`;
      return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
    },
    // "2023:07:14 21:42:08" (EXIF style) -> "2023-07-14 21:42:08"
    exif(text) {
      return String(text || "").replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3");
    },
    plural(n, one, many) {
      return `${fmt.num(n)} ${n === 1 ? one : many || `${one}s`}`;
    },
    base(p) {
      if (!p) return "";
      const parts = String(p).split(/[\\/]/).filter(Boolean);
      return parts.length ? parts[parts.length - 1] : p;
    },
    dir(p) {
      const s = String(p || "");
      const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
      return i > 0 ? s.slice(0, i) : s;
    },
    ext(p) {
      const b = fmt.base(p);
      const i = b.lastIndexOf(".");
      return i > 0 ? b.slice(i + 1).toLowerCase() : "";
    },
  };
  MF.fmt = fmt;

  // ---------------------------------------------------------------------------
  // Bridge to the app (Electron preload, or the test harness in a browser)
  // ---------------------------------------------------------------------------

  const bridge = window.myfile || window.myfileHarness;
  if (!bridge) {
    document.addEventListener("DOMContentLoaded", () => {
      document.body.textContent = "myFile must be opened as an app (myFile.app), not in a browser.";
    });
  }
  let taskCounter = 0;

  /**
   * Starts a backend operation. Returns { id, promise, cancel }. The promise
   * resolves with the result or rejects with an Error (err.cancelled for cancel).
   */
  function start(name, payload, { onProgress } = {}) {
    const id = `t${Date.now().toString(36)}${++taskCounter}`;
    const promise = bridge.task(id, name, payload || {}, onProgress).then((res) => {
      if (res && res.ok) return res.result;
      const err = new Error((res && res.error) || "Something went wrong");
      err.cancelled = Boolean(res && res.cancelled);
      err.details = res && res.details;
      throw err;
    });
    return { id, promise, cancel: () => bridge.cancel(id), softStop: () => bridge.softStop(id) };
  }

  MF.api = {
    platform: bridge ? bridge.platform : "unknown",
    start,
    run: (name, payload, opts) => start(name, payload, opts).promise,
    dialog: (opts) => bridge.dialog(opts),
    reveal: (p) => bridge.reveal(p),
    open: (p) => bridge.open(p),
    openExternal: (u) => bridge.openExternal(u),
    pathForFile: (f) => bridge.pathForFile(f),
    setTheme: (t) => bridge.setTheme(t),
    onMenu: (fn) => bridge.onMenu(fn),
  };

  // ---------------------------------------------------------------------------
  // Toasts
  // ---------------------------------------------------------------------------

  let toastBox = null;
  MF.toast = function toast(title, { detail, kind = "info", action, timeout = 4200 } = {}) {
    if (!toastBox) {
      toastBox = h("div.toasts");
      document.body.appendChild(toastBox);
    }
    const iconName = { success: "check", error: "alert", warn: "alert", info: "info" }[kind] || "info";
    const el = h(
      `div.toast.${kind}`,
      { attrs: { role: kind === "error" ? "alert" : "status" } },
      h("div.ti", icon(iconName)),
      h("div.tb", h("div.tt", title), detail ? h("div.td", detail) : null),
      action ? h("button.btn.sm.tact", { on: { click: () => { action.run(); close(); } } }, action.label) : null,
    );
    toastBox.appendChild(el);
    let timer = setTimeout(close, timeout);
    el.addEventListener("mouseenter", () => clearTimeout(timer));
    el.addEventListener("mouseleave", () => (timer = setTimeout(close, 1800)));
    function close() {
      clearTimeout(timer);
      el.classList.add("out");
      setTimeout(() => el.remove(), 260);
    }
    return close;
  };

  MF.fail = function fail(err, title = "That didn't work") {
    if (err && err.cancelled) {
      MF.toast("Cancelled", { kind: "info", timeout: 2200 });
      return;
    }
    MF.toast(title, { kind: "error", detail: err && err.message ? err.message : String(err), timeout: 7000 });
  };

  // ---------------------------------------------------------------------------
  // Confirm dialog
  // ---------------------------------------------------------------------------

  MF.confirm = function confirm({ title, message, confirm: ok = "Continue", cancel = "Cancel", danger = false, iconName }) {
    return new Promise((resolve) => {
      const done = (value) => {
        back.remove();
        document.removeEventListener("keydown", onKey, true);
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === "Escape") done(false);
        if (e.key === "Enter") done(true);
      };
      const okBtn = h(`button.btn.${danger ? "danger" : "primary"}`, { on: { click: () => done(true) } }, ok);
      const back = h(
        "div.modal-back",
        { on: { mousedown: (e) => e.target === back && done(false) } },
        h(
          "div.modal",
          { attrs: { role: "dialog", "aria-modal": "true" } },
          h("div.mb", h(`div.mi${danger ? ".danger" : ""}`, icon(iconName || (danger ? "alert" : "info"))), h("div", h("h3", title), message ? h("p", message) : null)),
          h("div.mf", h("button.btn", { on: { click: () => done(false) } }, cancel), okBtn),
        ),
      );
      document.body.appendChild(back);
      document.addEventListener("keydown", onKey, true);
      okBtn.focus();
    });
  };

  // ---------------------------------------------------------------------------
  // Busy overlay with progress and Cancel
  // ---------------------------------------------------------------------------

  /**
   * Runs a task behind a progress card. describe(progress) returns
   * { label, ratio (0..1 or null), left, right, sub, current, active } for display.
   */
  /**
   * Speed and time-left text for long reads and copies. The speed is measured over the
   * last ~10 seconds, so a fast start (drive cache) doesn't make the estimate too hopeful.
   * Call it with every progress event: rate(doneBytes, totalBytes) -> "22 MB/s · 4 min left" or "".
   */
  MF.rateTracker = function rateTracker() {
    const samples = [];
    return (done, total) => {
      const now = Date.now();
      if (!(done > 0)) return "";
      samples.push({ t: now, b: done });
      while (samples.length > 2 && now - samples[0].t > 10000) samples.shift();
      const first = samples[0];
      const secs = (now - first.t) / 1000;
      if (secs < 2) return "";
      const rate = (done - first.b) / secs;
      if (!(rate > 0)) return "";
      const eta = total > done ? ((total - done) / rate) * 1000 : null;
      return `${fmt.size(rate)}/s${eta !== null ? ` · ${fmt.duration(eta)} left` : ""}`;
    };
  };

  MF.busy = async function busy(title, name, payload, describe, { softStop = null } = {}) {
    const bar = h("div");
    const progress = h("div.progress.indeterminate", bar);
    const left = h("span.l");
    const right = h("span.r");
    const pct = h("span.pct");
    const note = h("div.sub");
    const current = h("div.current");
    const label = h("span", title);
    const cancelBtn = h("button.btn", softStop ? "Cancel now" : "Cancel");
    if (softStop && softStop.cancelTitle) cancelBtn.title = softStop.cancelTitle;
    const stopBtn = softStop ? h("button.btn.primary", { title: softStop.title || "" }, softStop.label) : null;
    let stopping = false;
    const overlay = h(
      "div.busy",
      h("div.busy-card", h("div.title", h("div.spinner"), label), h("div.bar-row", progress, pct), h("div.detail", left, right), note, current, h("div.foot", stopBtn, cancelBtn)),
    );
    document.body.appendChild(overlay);
    const job = start(name, payload, {
      onProgress: (p) => {
        const d = describe ? describe(p) || {} : {};
        if (d.label) label.textContent = stopping ? softStop.doing : d.label;
        if (typeof d.ratio === "number" && Number.isFinite(d.ratio)) {
          progress.classList.remove("indeterminate");
          bar.style.width = `${Math.max(1, Math.min(100, d.ratio * 100))}%`;
          // 100% only when the work is really done, so it never reads "100%" while still running.
          pct.textContent = `${Math.min(d.ratio >= 1 ? 100 : 99, Math.floor(d.ratio * 100))}%`;
        } else {
          progress.classList.add("indeterminate");
          pct.textContent = "";
        }
        left.textContent = d.left || "";
        right.textContent = d.right || "";
        note.textContent = d.sub || "";
        if (Array.isArray(d.active) && d.active.length > 1) {
          // Several files at once: one stable line per file.
          current.classList.add("multi");
          replace(current, d.active.map((name) => h("div", name)));
        } else {
          current.classList.remove("multi");
          current.textContent = (Array.isArray(d.active) && d.active[0]) || d.current || "";
        }
      },
    });
    if (stopBtn) {
      stopBtn.addEventListener("click", () => {
        stopping = true;
        stopBtn.disabled = true;
        label.textContent = softStop.doing;
        job.softStop();
      });
    }
    cancelBtn.addEventListener("click", () => {
      cancelBtn.disabled = true;
      cancelBtn.textContent = "Cancelling…";
      job.cancel();
    });
    try {
      return await job.promise;
    } finally {
      overlay.remove();
    }
  };

  // ---------------------------------------------------------------------------
  // Little helpers
  // ---------------------------------------------------------------------------

  MF.debounce = function debounce(fn, ms = 250) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  };

  MF.copyText = async function copyText(text, what = "Copied") {
    try {
      await navigator.clipboard.writeText(text);
      MF.toast(what, { kind: "success", timeout: 1600 });
    } catch {
      MF.toast("Couldn't copy to the clipboard", { kind: "warn" });
    }
  };

  MF.mapsUrl = (lat, lon) => `https://maps.apple.com/?ll=${lat},${lon}&q=${lat},${lon}`;
})();

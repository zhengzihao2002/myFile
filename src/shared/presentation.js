/* Display preferences only. Canonical dates, paths, form values and metadata writes stay untouched. */
(function (root, factory) {
  if (typeof module === "object" && module.exports)
    module.exports = factory(require("./zh-CN"));
  else root.MyFilePresentation = factory(root.MyFileChinese || {});
})(typeof globalThis !== "undefined" ? globalThis : this, function (catalog) {
  "use strict";
  const normalize = (s) => ({
    language: s && s.language === "zh-CN" ? "zh-CN" : "en",
    timeFormat: s && s.timeFormat === "12" ? "12" : "24",
  });
  const patterns = Object.entries(catalog)
    .filter(([key]) => /\{\d+(?::number)?\}/.test(key))
    .map(([key, value]) => {
      const parts = key.split(/(\{\d+(?::number)?\})/),
        indices = [];
      const source = parts
        .map((part) => {
          const parameter = /^\{(\d+)(:number)?\}$/.exec(part);
          if (!parameter) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          indices.push(parameter[1]);
          return parameter[2] ? "([\\d,]+(?:\\.\\d+)?)" : "([\\s\\S]*?)";
        })
        .join("");
      return { regex: new RegExp("^" + source + "$"), value, indices };
    })
    .sort((a, b) => b.regex.source.length - a.regex.source.length);
  function translate(text, language) {
    if (typeof text !== "string" || language !== "zh-CN" || !text.trim())
      return text;
    const trimmed = text.trim();
    let result = Object.prototype.hasOwnProperty.call(catalog, trimmed)
      ? catalog[trimmed]
      : undefined;
    if (result === undefined) {
      for (const pattern of patterns) {
        const match = pattern.regex.exec(trimmed);
        if (match) {
          const values = {};
          pattern.indices.forEach((index, i) => (values[index] = match[i + 1]));
          result = pattern.value.replace(
            /\{(\d+)\}/g,
            (_, index) => values[index] ?? "",
          );
          break;
        }
      }
    }
    return result === undefined
      ? text
      : text.slice(0, text.indexOf(trimmed)) +
          result +
          text.slice(text.indexOf(trimmed) + trimmed.length);
  }
  function clock(text, format, language = "en") {
    if (typeof text !== "string" || format !== "12") return text;
    // Only displayed timestamps or standalone clock values. UTC offsets and
    // durations (e.g. 1:20) must never be interpreted as a time of day.
    return text.replace(
      /(^|\b\d{4}[-:]\d{2}[-:]\d{2}[ T])(?:(上午|下午)\s+)?(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(?:\s+([AP]M))?/g,
      (all, prefix, chinesePeriod, hour, minute, second, fraction, ampm, index, original) => {
        const period = chinesePeriod || ampm;
        const h = period ? Number(hour) % 12 + (period === "PM" || period === "下午" ? 12 : 0) : Number(hour);
        if (
          h > 23 ||
          (period && (Number(hour) < 1 || Number(hour) > 12)) ||
          Number(minute) > 59 ||
          (second !== undefined && Number(second) > 59)
        )
          return all;
        if (
          !prefix &&
          !/^\s*(?:UTC[+-]|[+-]\d{2}:\d{2}|Z\b)/.test(
            original.slice(index + all.length),
          )
        )
          return all;
        const time = `${String(h % 12 || 12).padStart(2, "0")}:${minute}${second === undefined ? "" : ":" + second + (fraction || "")}`;
        return language === "zh-CN"
          ? `${prefix}${h < 12 ? "上午" : "下午"} ${time}`
          : `${prefix}${time} ${h < 12 ? "AM" : "PM"}`;
      },
    );
  }
  function present(text, settings, raw = false) {
    const s = normalize(settings);
    return clock(raw ? text : translate(text, s.language), s.timeFormat, s.language);
  }
  function observe(doc, getSettings) {
    const records = new WeakMap(),
      attributes = new WeakMap();
    const skip = "script,style,textarea,code,pre,[data-presentation=off]";
    // User data is never translated. Dates in these values can still use AM/PM.
    const raw = "[data-presentation-raw]";
    const fileNames =
      ".cell-path,.fname,.bt-name,.bt-dir,.item .name,.item .path,.ptitle .n,.ptitle .small,#title,#root,.node .label,.tcard .tn,.tcard .tp,.tnode .nm,.busy-card .current,.stat .n,.root-path,[data-user-data]";
    function text(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest(skip) || parent.closest(fileNames)) return;
      const old = records.get(node),
        source = old && node.data === old.rendered ? old.source : node.data;
      const rendered = present(
        source,
        getSettings(),
        Boolean(parent.closest(raw)),
      );
      records.set(node, { source, rendered });
      // Options without explicit values otherwise change their submission value
      // when their label is translated.
      if (parent.tagName === "OPTION" && !parent.hasAttribute("value"))
        parent.value = parent.textContent;
      if (node.data !== rendered) node.data = rendered;
    }
    function attrs(el) {
      if (el.closest(skip) || el.closest(fileNames)) return;
      let record = attributes.get(el);
      if (!record) {
        record = {};
        attributes.set(el, record);
      }
      for (const name of [
        "title",
        "placeholder",
        "aria-label",
        "aria-description",
      ]) {
        const value = el.getAttribute(name);
        if (value === null) continue;
        if (name === "title" && el.matches(".node,.stat,.item")) continue;
        const old = record[name],
          source = old && value === old.rendered ? old.source : value;
        const rendered = present(
          source,
          getSettings(),
          Boolean(el.closest(raw)),
        );
        record[name] = { source, rendered };
        if (value !== rendered) el.setAttribute(name, rendered);
      }
    }
    function apply(root = doc.body) {
      if (!root) return;
      if (root.nodeType === 3) {
        text(root);
        return;
      }
      if (root.nodeType !== 1 && root.nodeType !== 9) return;
      if (root.nodeType === 1) attrs(root);
      const walker = doc.createTreeWalker(root, 5);
      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeType === 3) text(node);
        else attrs(node);
      }
    }
    const observer = new doc.defaultView.MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "characterData") text(m.target);
        else if (m.type === "attributes") attrs(m.target);
        else for (const node of m.addedNodes) apply(node);
      }
    });
    observer.observe(doc.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "title",
        "placeholder",
        "aria-label",
        "aria-description",
      ],
    });
    function refresh() {
      doc.documentElement.lang = normalize(getSettings()).language;
      apply(doc.documentElement);
    }
    refresh();
    return { refresh, disconnect: () => observer.disconnect() };
  }
  return { normalize, translate, clock, present, observe };
});

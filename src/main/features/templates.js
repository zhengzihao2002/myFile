"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(__dirname, "..", "templates");

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// JSON that is safe inside <script type="application/json">.
function safeJson(value) {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .split(LS)
    .join("\\u2028")
    .split(PS)
    .join("\\u2029");
}

/** Fills __KEY__ placeholders. Keys starting with DATA get JSON, others escaped text. */
function renderTemplate(name, values) {
  let html = fs.readFileSync(path.join(DIR, name), "utf8");
  for (const [key, value] of Object.entries(values)) {
    if (key === "PREFERENCES") continue;
    const text = key.startsWith("DATA") ? safeJson(value) : escapeHtml(value);
    html = html.split(`__${key}__`).join(text);
  }
  if (values.PREFERENCES) {
    const preferences = require("../../shared/presentation").normalize(values.PREFERENCES);
    const shared = ["zh-CN.js", "presentation.js"].map(file => fs.readFileSync(path.join(__dirname, "..", "..", "shared", file), "utf8")).join("\n").replace(/<\/script/gi, "<\\/script");
    html = html.replace("</body>", `<script>\n${shared}\nMyFilePresentation.observe(document,()=>(${safeJson(preferences)}));\n</script>\n</body>`);
  }
  return html;
}

module.exports = { renderTemplate, escapeHtml, safeJson };

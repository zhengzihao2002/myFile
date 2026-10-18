"use strict";

// Development harness: serves the real renderer in any browser and connects
// it to the real backend over HTTP, so the whole app can be exercised
// without Electron (used by test/ui.test.js).
//
//   node test/harness/server.js [port]

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" };

function createServer({ dataDir } = {}) {
  if (dataDir) process.env.MYFILE_DATA_DIR = dataDir;
  const { resolveRuntime } = require("../../src/main/lib/runtime");
  const { ExifTool } = require("../../src/main/lib/exiftool");
  const { createContext, createHandlers, invoke } = require("../../src/main/handlers");

  const runtime = resolveRuntime({ isPackaged: false, mainDir: path.join(ROOT, "src", "main") });
  const et = new ExifTool({ perl: runtime.perl, script: runtime.exiftool });
  const trashDir = path.join(runtime.dataDir, "trash");
  const shellLog = [];
  // MYFILE_FAKE_DRIVES='{"/some/folder": {"fsType": "exfat", ...}}' makes those
  // folders look like external drives, to preview the FileSync drive UI.
  const realVolumes = require("../../src/main/lib/volumes");
  const fakeDrives = process.env.MYFILE_FAKE_DRIVES ? JSON.parse(process.env.MYFILE_FAKE_DRIVES) : {};
  const volumeInfo = {
    ...realVolumes,
    async info(p) {
      for (const [root, v] of Object.entries(fakeDrives)) {
        if (path.resolve(p) === root || path.resolve(p).startsWith(root + path.sep)) {
          const real = await realVolumes.info(p);
          return { ...real, mountPoint: root, name: path.basename(root), external: true, ejectable: true, ...v };
        }
      }
      return realVolumes.info(p);
    },
  };
  const ctx = createContext({
    runtime,
    et,
    volumeInfo,
    keepAwake: () => () => {},
    appVersion: require("../../package.json").version,
    fileUrl: (p) => `/file?p=${encodeURIComponent(p)}`,
    trash: async (p) => {
      fs.mkdirSync(trashDir, { recursive: true });
      fs.renameSync(p, path.join(trashDir, `${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${path.basename(p)}`));
    },
    extraInfo: { packaged: false, harness: true },
  });
  const handlers = createHandlers(ctx);
  const running = new Map();
  const clients = new Set();

  const send = (msg) => {
    const line = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of clients) res.write(line);
  };

  const readBody = (req) =>
    new Promise((resolve) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => resolve(body ? JSON.parse(body) : {}));
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "POST" && url.pathname === "/task") {
        const { id, name, payload } = await readBody(req);
        const controller = new AbortController();
        controller.soft = new AbortController();
        running.set(id, controller);
        const out = await invoke(handlers, name, payload, { signal: controller.signal, softSignal: controller.soft.signal, progress: (data) => send({ id, data }) });
        running.delete(id);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(out));
      }
      if (req.method === "POST" && url.pathname === "/cancel") {
        const { id } = await readBody(req);
        const c = running.get(id);
        if (c) c.abort();
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(Boolean(c)));
      }
      if (req.method === "POST" && url.pathname === "/softStop") {
        const { id } = await readBody(req);
        const c = running.get(id);
        if (c && c.soft) c.soft.abort();
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(Boolean(c)));
      }
      if (req.method === "POST" && url.pathname === "/shell") {
        shellLog.push(await readBody(req));
        res.writeHead(200, { "content-type": "application/json" });
        return res.end("true");
      }
      if (url.pathname === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(":ok\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (url.pathname === "/file") return serveFile(url.searchParams.get("p"), req, res);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(302, { location: "/src/renderer/index.html" });
        return res.end();
      }
      const file = path.join(ROOT, decodeURIComponent(url.pathname));
      if (!file.startsWith(ROOT)) {
        res.writeHead(403);
        return res.end();
      }
      if (url.pathname === "/src/renderer/index.html") {
        const html = fs.readFileSync(file, "utf8").replace('<script src="js/core.js"></script>', '<script src="/test/harness/bridge.js"></script>\n<script src="js/core.js"></script>');
        res.writeHead(200, { "content-type": MIME[".html"] });
        return res.end(html);
      }
      return serveFile(file, req, res);
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(err && err.stack ? err.stack : err));
    }
  });

  function serveFile(file, req, res) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      res.writeHead(404);
      return res.end();
    }
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Number(range[2]) : st.size - 1;
      res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${st.size}`, "accept-ranges": "bytes", "content-length": end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { "content-type": type, "content-length": st.size, "accept-ranges": "bytes" });
    fs.createReadStream(file).pipe(res);
  }

  return {
    server,
    ctx,
    shellLog,
    close() {
      et.close();
      for (const c of clients) c.end();
      server.close();
    },
  };
}

if (require.main === module) {
  const port = Number(process.argv[2]) || 5174;
  const { server } = createServer();
  server.listen(port, () => console.log(`myFile harness on http://localhost:${port}/`));
}

module.exports = { createServer };

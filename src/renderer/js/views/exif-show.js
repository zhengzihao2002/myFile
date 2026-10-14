/* EXIF › Show */
(function () {
  "use strict";

  const { h, icon, fmt, api, replace } = MF;
  const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

  function kvRow(k, v, extra) {
    if (v === null || v === undefined || v === "") return null;
    return h("div.kvr", h("div.k", k), h("div.v.selectable", v, extra || null));
  }

  function parseWall(text) {
    const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(text || "");
    return m ? { y: +m[1], mo: +m[2], d: +m[3], hh: m[4], mm: m[5], ss: m[6] } : null;
  }

  MF.views["exif-show"] = {
    crumb: "EXIF",
    title: "Show",
    subtitle: "Everything a photo or video knows about itself.",
    full: true,
    mount() {
      let files = [];
      const thumbs = new Map(); // path -> URL for photos the window can show
      let index = -1;
      let info = null;
      let loadToken = 0;
      let tagFilter = "";

      const drop = MF.DropZone({
        accept: "media",
        multiple: true,
        title: "Drop photos or videos to inspect",
        subtitle: "JPEG, HEIC, PNG, RAW, MOV, MP4 and more · or click to choose",
        glyph: "photo",
        onChange: (paths, infos) => {
          if (!paths.length) return;
          for (const info of infos) if (info.url) thumbs.set(info.path, info.url);
          addFiles(paths);
          drop.clear();
        },
      });
      const emptyView = h(
        "div",
        { style: { margin: "auto", width: "min(620px, 90%)", padding: "40px 0" } },
        drop.el,
        h("p.muted.small", { style: { textAlign: "center", marginTop: "14px" } }, "Nothing is changed by looking. To edit, use EXIF › Modify."),
      );

      const stageName = h("div.fname");
      const stageView = h("div.stage-view");
      const strip = h("div.strip.hidden");
      const counter = h("span.muted.small.num");
      const prevBtn = MF.Button("", { kind: "ghost", size: "sm", iconName: "chevron", title: "Previous (←)", onClick: () => select(index - 1) });
      prevBtn.querySelector("svg").style.transform = "rotate(180deg)";
      const nextBtn = MF.Button("", { kind: "ghost", size: "sm", iconName: "chevron", title: "Next (→)", onClick: () => select(index + 1) });
      const stage = h(
        "div.stage",
        h(
          "div.stage-bar",
          prevBtn,
          nextBtn,
          stageName,
          counter,
          h("span.spacer"),
          MF.Button("Reveal", { kind: "ghost", size: "sm", iconName: "reveal", onClick: () => files[index] && api.reveal(files[index]) }),
          MF.Button("Open", { kind: "ghost", size: "sm", iconName: "external", onClick: () => files[index] && api.open(files[index]) }),
        ),
        stageView,
        strip,
      );
      const side = h("div.panel-side", h("div.scroll"));
      const inspectView = h("div.inspect", stage, side);
      const root = h("div", { style: { display: "flex", width: "100%", height: "100%" } }, emptyView);

      // Dropping more files anywhere on the view adds them.
      root.addEventListener("dragover", (e) => e.preventDefault());
      root.addEventListener("drop", (e) => {
        if (!files.length) return;
        e.preventDefault();
        const paths = [...(e.dataTransfer.files || [])].map((f) => api.pathForFile(f)).filter(Boolean);
        if (paths.length) drop.add(paths);
      });
      document.addEventListener("keydown", (e) => {
        if (!root.isConnected || !files.length || /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
        if (e.key === "ArrowRight") select(index + 1);
        if (e.key === "ArrowLeft") select(index - 1);
      });

      function addFiles(paths) {
        const known = new Set(files);
        const fresh = paths.filter((p) => !known.has(p));
        files = files.concat(fresh);
        replace(root, inspectView);
        renderStrip();
        select(fresh.length ? files.indexOf(fresh[0]) : index);
        MF.refreshHeader();
      }

      function clearAll() {
        files = [];
        index = -1;
        info = null;
        replace(root, emptyView);
        MF.refreshHeader();
      }

      function renderStrip() {
        strip.classList.toggle("hidden", files.length < 2);
        replace(
          strip,
          files.map((f, i) =>
            h(
              `button${i === index ? ".on" : ""}`,
              { type: "button", title: fmt.base(f), on: { click: () => select(i) } },
              thumbs.has(f) ? h("img", { src: thumbs.get(f), alt: "", loading: "lazy" }) : icon(/\.(mov|mp4|m4v|3gp|avi|mkv|mts|m2ts|webm)$/i.test(f) ? "video" : "photo"),
            ),
          ),
        );
        counter.textContent = files.length > 1 ? `${index + 1} of ${files.length}` : "";
        prevBtn.disabled = index <= 0;
        nextBtn.disabled = index >= files.length - 1;
      }

      async function select(i) {
        if (i < 0 || i >= files.length) return;
        index = i;
        renderStrip();
        const file = files[i];
        const token = ++loadToken;
        stageName.textContent = fmt.base(file);
        replace(stageView, h("div.placeholder", h("div.spin", { style: { width: "22px", height: "22px", margin: "0 auto 10px", border: "2.5px solid var(--accent-soft)", borderTopColor: "var(--accent)", borderRadius: "50%", animation: "spin .8s linear infinite" } }), "Reading metadata…"));
        replace(side.firstChild, h("div.muted.small", { style: { padding: "8px" } }, "Reading metadata…"));
        try {
          const result = await api.run("exif.inspect", { path: file });
          if (token !== loadToken) return;
          info = result;
          renderPreview(result, token);
          renderPanel(result);
        } catch (err) {
          if (token !== loadToken) return;
          replace(stageView, MF.Empty({ iconName: "alert", title: "Can't read this file", text: err.message }));
          replace(side.firstChild, MF.Callout("red", err.message));
        }
      }

      function showImage(url) {
        replace(stageView, h("div.fit", h("img", { src: url, alt: "", draggable: false })));
      }

      async function renderPreview(result, token) {
        const p = result.preview;
        if (p.type === "image") return showImage(p.url);
        if (p.type === "video") {
          const video = h("video", { src: p.url, controls: true, preload: "metadata", playsInline: true });
          video.addEventListener("error", async () => {
            const poster = await api.run("exif.poster", { path: result.path }).catch(() => null);
            if (token !== loadToken) return;
            if (poster && poster.url) {
              replace(stageView, h("div.fit.with-note", h("img", { src: poster.url, alt: "" }), h("p.muted.small", { style: { margin: "0" } }, "This video's format can't play here; showing a still frame.")));
            } else replace(stageView, MF.Empty({ iconName: "video", title: "Can't play this video here", text: "Open it in QuickTime Player to watch it. All of its metadata is on the right." }));
          });
          replace(stageView, h("div.fit", video));
          return;
        }
        if (p.type === "pending") {
          replace(stageView, h("div.placeholder", "Making a preview…"));
          const res = await api.run("exif.preview", { path: result.path }).catch(() => null);
          if (token !== loadToken) return;
          if (res && res.url) showImage(res.url);
          else replace(stageView, MF.Empty({ iconName: "photo", title: "No preview", text: (res && res.note) || "This file type can't be previewed, but its metadata is on the right." }));
          return;
        }
        replace(stageView, MF.Empty({ iconName: "file", title: "Not a photo or video", text: "Its metadata is still shown on the right." }));
      }

      function dateCard(r) {
        const t = r.taken;
        const w = t ? parseWall(t.text) : null;
        const fileRow = (k, v, note) => h("div.kvr", h("div.k", k, h("span.tag-src", note)), h("div.v.selectable", v));
        return h(
          "div.kv",
          h("div.kvh", icon("calendar"), "Dates", h("div.right", t ? MF.Button("Use for file dates", { size: "sm", title: "Set this file's Created and Modified dates to its EXIF date", onClick: () => MF.go("exif-modify", { mode: "self", paths: [r.path] }) }) : null)),
          // The date stored inside the photo or video itself.
          h("div.date-label", "EXIF date", h("span.badge.accent", "inside the file")),
          w
            ? h(
                "div.big-date",
                h("div.cal", h("div.mo", MONTHS[w.mo - 1]), h("div.dy", String(w.d))),
                h(
                  "div",
                  h("div.when", `${w.y}-${String(w.mo).padStart(2, "0")}-${String(w.d).padStart(2, "0")}  ${w.hh}:${w.mm}:${w.ss}`),
                  h("div.tz", `${t.offset ? `Time zone ${t.offset}` : "No time zone stored"} · from ${t.source}`),
                ),
              )
            : h("div.big-date", h("div.muted", "This file has no EXIF date.")),
          // The dates the file system keeps, which Finder shows.
          h("div.date-label", { style: { color: "var(--muted)", paddingBottom: "6px", borderTop: "1px solid var(--line)", marginTop: "2px" } }, "File dates", h("span.badge", "what Finder shows")),
          fileRow("Created", fmt.date(r.times.createdMs), "file system"),
          fileRow("Modified", fmt.date(r.times.modifiedMs), "file system"),
          fileRow("Accessed", fmt.date(r.times.accessedMs), "file system"),
        );
      }

      function cameraCard(s) {
        const exposure = [s.exposure ? `${s.exposure} s` : null, s.aperture ? `ƒ/${s.aperture}` : null, s.iso ? `ISO ${s.iso}` : null, s.focalLength].filter(Boolean).join("  ·  ");
        const rows = [kvRow("Camera", s.camera), kvRow("Lens", s.lens), kvRow("Exposure", exposure), kvRow("Flash", s.flash), kvRow("Codec", s.codec), kvRow("Frame rate", s.frameRate), kvRow("Software", s.software)].filter(Boolean);
        if (!rows.length) return null;
        return h("div.kv", h("div.kvh", icon("camera"), "Capture"), rows);
      }

      function locationCard(r) {
        if (!r.gps) return h("div.kv", h("div.kvh", icon("pin"), "Location"), h("div.kvr", h("div.k", "GPS"), h("div.v.muted", "No location stored")));
        const { lat, lon, alt } = r.gps;
        const text = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
        return h(
          "div.kv",
          h(
            "div.kvh",
            icon("pin"),
            "Location",
            h("div.right", MF.Button("Copy", { size: "sm", iconName: "copy", onClick: () => MF.copyText(text, "Coordinates copied") }), MF.Button("Open in Maps", { size: "sm", iconName: "external", onClick: () => api.openExternal(MF.mapsUrl(lat, lon)) })),
          ),
          kvRow("Coordinates", text),
          kvRow("Altitude", alt === null ? null : `${alt.toFixed(1)} m`),
          kvRow("As stored", r.gps.text),
        );
      }

      function tagsCard(r) {
        const search = h("input", { placeholder: "Search tags and values", value: tagFilter, spellcheck: false });
        const body = h("div");
        const draw = () => {
          const term = tagFilter.trim().toLowerCase();
          let total = 0;
          replace(
            body,
            r.groups.map((g) => {
              const rows = term ? g.tags.filter((t) => `${t.tag} ${t.label} ${t.value}`.toLowerCase().includes(term)) : g.tags;
              total += rows.length;
              if (!rows.length) return null;
              return h(
                "details.group",
                { open: Boolean(term) },
                h("summary", icon("chevron"), g.label, h("span.c", String(rows.length))),
                rows.map((t) =>
                  h(
                    "div.tagrow",
                    { title: `${g.group}:${t.tag} — click to copy`, on: { click: () => MF.copyText(String(t.value), `${t.label} copied`) } },
                    h("div.k", t.label),
                    h("div.v", t.value),
                  ),
                ),
              );
            }),
            total ? null : h("div.muted.small", { style: { padding: "14px" } }, "No tags match."),
          );
        };
        search.addEventListener("input", MF.debounce(() => {
          tagFilter = search.value;
          draw();
        }, 120));
        draw();
        return h("div.kv", h("div.kvh", icon("tag"), `All metadata`, h("span.faint", { style: { fontWeight: "500" } }, `${fmt.num(r.tagCount)} tags`)), h("div", { style: { padding: "10px 12px" } }, h("div.input", icon("search"), search)), body);
      }

      function renderPanel(r) {
        const s = r.summary;
        const badges = [
          h(`span.badge.${r.kind === "video" ? "accent" : r.kind === "image" ? "blue" : ""}`, r.kind === "video" ? "Video" : r.kind === "image" ? "Photo" : "File"),
          s.fileType ? h("span.badge", s.fileType) : null,
          h("span.badge", fmt.size(r.size)),
          s.dimensions ? h("span.badge", s.dimensions) : null,
          s.megapixels ? h("span.badge", `${s.megapixels} MP`) : null,
          s.duration ? h("span.badge", s.duration) : null,
        ];
        replace(
          side.firstChild,
          h("div.ptitle", h("div.n.selectable", r.name), h("div.small.faint.selectable", { style: { marginTop: "2px", wordBreak: "break-all" } }, r.folder), h("div.m", badges)),
          dateCard(r),
          cameraCard(s),
          locationCard(r),
          h(
            "div.row",
            { style: { gap: "8px" } },
            MF.Button("Use as reference", { iconName: "wand", title: "Copy this file's date and location to other files", onClick: () => MF.go("exif-modify", { mode: "copy", reference: r.path }) }),
            MF.Button("Reveal in Finder", { iconName: "reveal", onClick: () => api.reveal(r.path) }),
          ),
          tagsCard(r),
        );
      }

      async function browse() {
        const chosen = await api.dialog({ mode: "open", kind: "file", multiple: true, title: "Choose photos or videos" });
        if (chosen && chosen.length) drop.add(chosen);
      }

      return {
        el: root,
        actions: () => [
          MF.Button("Open…", { iconName: "plus", onClick: browse }),
          files.length ? MF.Button("Clear", { kind: "ghost", iconName: "x", onClick: clearAll }) : null,
        ],
        onShow(params) {
          if (params.browse) browse();
          if (params.paths) drop.add(params.paths);
        },
      };
    },
  };
})();

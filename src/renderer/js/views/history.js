/* History */
(function () {
  "use strict";

  const { h, icon, fmt, api, replace } = MF;

  MF.views.history = {
    title: "History",
    subtitle: "Everything myFile has changed. Date and EXIF changes can be undone.",
    mount() {
      const list = h("div.card");
      const el = h("div.stack", list);

      async function refresh() {
        let entries;
        try {
          entries = await api.run("history.list");
        } catch (err) {
          return MF.fail(err);
        }
        if (!entries.length) {
          replace(list, MF.Empty({ iconName: "history", title: "No history yet", text: "When you change EXIF data, fix dates or sync folders, it is listed here." }));
          return;
        }
        replace(
          list,
          h(
            "div.history-list",
            entries.map((e) =>
              h(
                "div.hrow",
                h("div.hi", icon(MF.historyIcon(e.type))),
                h("div.ht", h("div.a", e.title), h("div.b", { title: e.summary }, e.summary)),
                h("div.when", { title: fmt.nice(e.at) }, fmt.ago(e.at)),
                e.reverted
                  ? h("span.badge", icon("undo"), "Undone")
                  : e.undoable
                    ? MF.Button("Undo", { size: "sm", iconName: "undo", onClick: () => undo(e) })
                    : h("span.badge", { title: e.type === "filesync" ? "Syncs aren't undone here. Items a sync replaced or removed are in the Trash, unless you chose Delete." : "This change can't be undone" }, "No undo"),
                MF.Button("", { kind: "ghost", size: "sm", iconName: "x", title: "Remove from history", onClick: () => remove(e) }),
              ),
            ),
          ),
        );
      }

      async function undo(e) {
        const ok = await MF.confirm({ title: `Undo “${e.title}”?`, message: "The EXIF values and file dates from before are put back. Files changed again since then are overwritten with those older values.", confirm: "Undo", iconName: "undo" });
        if (!ok) return;
        try {
          const res = await MF.busy("Undoing…", "history.revert", { id: e.id }, (p) => ({ ratio: p.total ? p.done / p.total : null, left: p.phase === "exif" ? "Restoring EXIF" : "Restoring dates", current: p.current }));
          MF.toast("Undone", { kind: res.failures.length ? "warn" : "success", detail: res.failures.length ? `${res.failures.length} item(s) couldn't be restored` : `${fmt.num(res.restored)} items restored` });
        } catch (err) {
          MF.fail(err);
        }
        refresh();
      }

      async function remove(e) {
        await api.run("history.remove", { id: e.id }).catch(MF.fail);
        refresh();
      }

      async function clearAll() {
        const ok = await MF.confirm({ title: "Clear all history?", message: "This forgets every entry and its undo information. Your files aren't changed.", confirm: "Clear", danger: true });
        if (!ok) return;
        await api.run("history.clear").catch(MF.fail);
        refresh();
      }

      return { el, onShow: refresh, actions: () => [MF.Button("Clear history", { kind: "ghost", iconName: "trash", onClick: clearAll })] };
    },
  };
})();

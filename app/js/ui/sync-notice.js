// A card above the notes when sync stopped working on this device (user request 2026-10-16): removed from the
// device list or its sync data deleted (sync is off there, the notes stayed), or blocked by the server's owner
// (sync resumes once the block ends). So nobody types on here and wonders why nothing syncs. It looks like the
// "only in this browser" card (storage-hint.js) and takes its place while it shows; the text comes from
// core/sync-state.js → syncNotice. Shown in every view: notes are edited in the archive too.
import { state, subscribe, setSync } from "../store.js";
import { syncNotice } from "../core/sync-state.js";
import { h, button } from "./dom.js";
import { icon } from "./icons.js";

const $ = id => document.getElementById(id);

/** `onLink`: Sync & sharing on "Link this device"; `onSync`: Sync & sharing (turning sync on). */
export function initSyncNotice({ onLink, onSync }) {
  const card = h("div", { class: "storage-hint sync-notice", id: "syncNotice", role: "status", hidden: true });
  $("viewHint").before(card);
  let shown = "";
  const render = () => {
    const n = syncNotice(state.sync);
    const key = n ? JSON.stringify(n) : "";
    card.hidden = !n;
    if (key === shown) return;
    shown = key;
    if (!n) return card.replaceChildren();
    const action = n.kind === "removed" ? button("Link again", "primary", onLink)
      : n.kind === "deleted" ? button("Turn on sync", "primary", onSync) : null;
    card.dataset.kind = n.kind;
    card.replaceChildren(...[
      h("span", { class: "storage-hint-icon", html: icon("sync") }),
      h("span", { class: "row-text" }, h("span", { class: "row-title" }, n.title), h("span", { class: "row-sub" }, n.sub)),
      n.closable && h("button", {
        class: "icon-btn storage-hint-close", type: "button", "aria-label": "Close", title: "Close", html: icon("close"),
        onclick: () => setSync({ ended: "" }),
      }),
      action && h("div", { class: "request-actions" }, action),
    ].filter(Boolean));
  };
  subscribe(render);
  render();
}

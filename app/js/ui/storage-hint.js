// Web app only: asks the browser to keep this site's storage (so it isn't
// evicted under storage pressure or, in Safari, after 7 days without a
// visit), and while sync is off shows that the notes live only in this
// browser — clearing the site's data deletes them. Hidden by the user, the
// hint comes back after HINT_PAUSE_DAYS (core/storage-hint.js).
import { Capacitor } from "../../vendor/capacitor-core.esm.js";
import { state, subscribe, updateSettings } from "../store.js";
import { showStorageHint, HINT_PAUSE_DAYS } from "../core/storage-hint.js";
import { h, button } from "./dom.js";
import { icon } from "./icons.js";
import { today } from "./format.js";
import { showSnackbar } from "./snackbar.js";

const native = Capacitor.isNativePlatform();
const $ = id => document.getElementById(id);

// Prototype variants (open decision): where the hint sits.
export const HINT_VARIANTS = { card: "Card (A)", strip: "Strip (B)", footer: "List end (C)" };

let actions;

export function initStorageHint({ onSync, onExport }) {
  actions = { onSync, onExport };
  if (!native) navigator.storage?.persisted?.().then(kept => kept || navigator.storage.persist()).catch(() => {});
  subscribe(render);
  render();
}

function hide() {
  updateSettings({ storageHintHidden: today() });
  showSnackbar(`Hint hidden for ${HINT_PAUSE_DAYS} days`, () => updateSettings({ storageHintHidden: null }));
}

function render() {
  const s = state.settings;
  const variant = HINT_VARIANTS[s.storageHint] ? s.storageHint : "card";
  const shown = showStorageHint({ native, syncOn: state.sync.enabled, hiddenOn: s.storageHintHidden, today: today() })
    && (variant === "strip" || state.view === "open");
  let el = $("storageHint");
  if (el?.dataset.variant === variant && !el.hidden === shown) return;
  el?.remove();
  el = build(variant);
  el.hidden = !shown;
  // Card: above the notes; strip: right below the top bar; list end: below the last note.
  if (variant === "card") $("viewHint").before(el);
  else if (variant === "strip") $("filterBar").before(el);
  else $("empty").after(el);
}

function build(variant) {
  const close = h("button", { class: "icon-btn storage-hint-close", type: "button", "aria-label": "Hide hint", title: "Hide hint", html: icon("close"), onclick: hide });
  const link = (label, fn) => h("button", { class: "link-btn", type: "button", onclick: fn }, label);
  const el = variant === "card"
    ? h("div", { class: "storage-hint card", role: "note" },
      h("span", { class: "storage-hint-icon", html: icon("device") }),
      h("span", { class: "row-text" },
        h("span", { class: "row-title" }, "Your notes are only stored in this browser"),
        h("span", { class: "row-sub" }, "Clearing this site's data deletes them. Turn on sync or export them to keep a copy.")),
      close,
      h("div", { class: "request-actions" }, button("Export", "", actions.onExport), button("Turn on sync", "primary", actions.onSync)))
    : h("div", { class: `storage-hint ${variant}`, role: "note" },
      h("span", { class: "storage-hint-text" }, "Your notes are only stored in this browser. ", link("Turn on sync", actions.onSync), " or ", link("export them", actions.onExport), "."),
      close);
  el.id = "storageHint";
  el.dataset.variant = variant;
  return el;
}

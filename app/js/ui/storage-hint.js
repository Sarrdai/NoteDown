// Web app only: asks the browser to keep this site's storage (so it isn't
// evicted under storage pressure or, in Safari, after 7 days without a
// visit), and while sync is off shows a card above the notes that they live
// only in this browser — clearing the site's data deletes them (chosen
// 2026-10-15 over a strip below the top bar and a line below the last note:
// it risks data loss, so it should be seen). Hidden by the user, the card
// comes back after HINT_PAUSE_DAYS (core/storage-hint.js).
import { Capacitor } from "../../vendor/capacitor-core.esm.js";
import { state, subscribe, updateSettings } from "../store.js";
import { showStorageHint, HINT_PAUSE_DAYS } from "../core/storage-hint.js";
import { h, button } from "./dom.js";
import { icon } from "./icons.js";
import { today } from "./format.js";
import { showSnackbar } from "./snackbar.js";

const native = Capacitor.isNativePlatform();
const $ = id => document.getElementById(id);

export function initStorageHint({ onSync, onExport }) {
  if (!native) navigator.storage?.persisted?.().then(kept => kept || navigator.storage.persist()).catch(() => {});
  const close = h("button", { class: "icon-btn storage-hint-close", type: "button", "aria-label": "Hide hint", title: "Hide hint", html: icon("close"), onclick: hide });
  const card = h("div", { class: "storage-hint", id: "storageHint", role: "note", hidden: true },
    h("span", { class: "storage-hint-icon", html: icon("device") }),
    h("span", { class: "row-text" },
      h("span", { class: "row-title" }, "Your notes are only stored in this browser"),
      h("span", { class: "row-sub" }, "Clearing this site's data deletes them. Turn on sync or export them to keep a copy.")),
    close,
    h("div", { class: "request-actions" }, button("Export", "", onExport), button("Turn on sync", "primary", onSync)));
  $("viewHint").before(card);
  const render = () => {
    card.hidden = state.view !== "open"
      || !showStorageHint({ native, syncOn: state.sync.enabled, hiddenOn: state.settings.storageHintHidden, today: today() });
  };
  subscribe(render);
  render();
}

/** ⋮ → "Prototype" → "Show storage hint again". */
export const showHintAgain = () => updateSettings({ storageHintHidden: null });

function hide() {
  updateSettings({ storageHintHidden: today() });
  showSnackbar(`Hint hidden for ${HINT_PAUSE_DAYS} days`, showHintAgain);
}

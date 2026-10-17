// Settings → Privacy → Screen lock (ui/settings.js): the switch and the time away after which NoteDown locks.
// The lock itself is ui/app-lock.js.
import { state, updateSettings } from "../store.js";
import { LOCK_AFTER } from "../core/app-lock.js";
import { privacyPlugin } from "../platform.js";
import { registerPage, refreshPage, panelPage } from "./sync-panel.js";
import { pickButton } from "./menu.js";
import { expectReturn } from "./app-lock.js";
import { h, text } from "./dom.js";

let canLock = true;      // whether the phone has a screen lock to use
let asked = false;

async function setLock(on) {
  const lock = state.settings.lock;
  if (!on) { updateSettings({ lock: { ...lock, on: false } }); return; }
  expectReturn();   // the system's prompt may take the app out of the foreground for a moment
  try {
    await privacyPlugin().unlock({ title: "Turn on screen lock" });
    updateSettings({ lock: { ...lock, on: true } });
  } catch (e) {
    if (e?.code === "unavailable") canLock = false;
  }
}

registerPage("settingsLock", {
  title: "Screen lock",
  render: () => {
    if (!asked) {
      asked = true;
      privacyPlugin().get().then(r => { canLock = r.canLock; if (panelPage() === "settingsLock") refreshPage({ keepScroll: true }); }).catch(() => {});
    }
    const lock = state.settings.lock;
    return [
      text("Lock NoteDown with your phone's screen lock — PIN, pattern, password or fingerprint."),
      h("label", { class: "setting-row" + (canLock || lock.on ? "" : " off") }, h("span", { class: "setting-label" }, "Screen lock"),
        h("input", { type: "checkbox", class: "switch", role: "switch", checked: lock.on, disabled: !canLock && !lock.on,
          onchange: async e => { await setLock(e.target.checked); refreshPage({ keepScroll: true }); } })),
      !canLock && !lock.on && text("Set up a screen lock in your phone's settings first.", "sheet-text muted"),
      h("div", { class: "setting-row" + (lock.on ? "" : " off") }, h("span", { class: "setting-label" }, "Lock"),
        Object.assign(pickButton(lock.after, LOCK_AFTER, v => updateSettings({ lock: { ...state.settings.lock, after: v } }), { cls: "ext-select", label: "Lock" }), { disabled: !lock.on })),
      text("Notifications still come while NoteDown is locked; what they show is set under Reminders.", "sheet-text muted"),
    ];
  },
});

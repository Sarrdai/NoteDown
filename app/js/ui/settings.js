// The settings (⋮ → "Settings…"): the app's own settings in one place
// instead of the top bar and ⋮ — the theme, the due-date reminders
// (ui/reminders.js), links & media (ui/external-settings.js), a way to the
// Sync & sharing panel and the Google Keep import. Its pages live in the
// Sync & sharing panel's container (ui/sync-panel.js), so they look and go
// back alike.
import { state, updateSettings } from "../store.js";
import { registerPage, openPanel, go, refreshPage, row, section, statusText, syncOnRequest } from "./sync-panel.js";
import { reminderSummary } from "./reminders.js";
import { externalSummary } from "./external-settings.js";
import { h } from "./dom.js";

export const FLAVORS = { system: "System", latte: "Latte", frappe: "Frappé", macchiato: "Macchiato", mocha: "Mocha" };

/** Opens the settings, or with `page` one of its pages ("reminders", "links") on top of them. */
export function openSettings(page) {
  openPanel("settings");
  if (page) go({ reminders: "settingsReminders", links: "settingsLinks" }[page]);
}

registerPage("settings", {
  title: "Settings",
  render: () => [
    section("Appearance"),
    h("label", { class: "setting-row" }, h("span", { class: "setting-label" }, "Theme"),
      h("select", { class: "ext-select", onchange: e => { updateSettings({ flavor: e.target.value }); refreshPage({ keepScroll: true }); } },
        ...Object.entries(FLAVORS).map(([id, label]) => h("option", { value: id, selected: state.settings.flavor === id }, label)))),
    section("Notes"),
    h("ul", { class: "sheet-card" },
      row({ icon: "bell", title: "Reminders", sub: reminderSummary(), open: () => go("settingsReminders") }),
      row({ icon: "link", title: "Links & media", sub: externalSummary(), open: () => go("settingsLinks") })),
    section("Sync"),
    h("ul", { class: "sheet-card" },
      row({ icon: "cloud", title: "Sync & sharing", sub: state.sync.enabled ? statusText() : "Off", open: () => { go(state.sync.enabled ? "overview" : "off"); syncOnRequest(); } })),
    section("Data"),
    h("ul", { class: "sheet-card" },
      row({ icon: "restore", title: "Import from Google Keep", sub: "From a Google Takeout ZIP file", open: () => { location.href = new URL("../../import/", import.meta.url).href; } })),
  ],
});

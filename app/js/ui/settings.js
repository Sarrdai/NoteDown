// The settings (⋮ → "Settings…"): the app's own settings in one place
// instead of the top bar and ⋮ — the theme, the Android-only Privacy section (screen lock, screen security,
// incognito keyboard, speech recognition), the due-date reminders
// (ui/reminders.js), the tidy-up reminder (ui/tidy-settings.js), links & media (ui/external-settings.js), a way to the
// Sync & sharing panel, the Google Keep import and "About" (version,
// open-source licenses (ui/licenses.js), privacy policy, terms of use,
// source code). Its pages live in the
// Sync & sharing panel's container (ui/sync-panel.js), so they look and go
// back alike.
import { state, updateSettings } from "../store.js";
import { registerPage, openPanel, go, refreshPage, row, section, statusText, syncOnRequest, legalUrl } from "./sync-panel.js";
import { licenseCount, preloadLicenses } from "./licenses.js";
import { appInfo } from "../app-info.js";
import { reminderSummary } from "./reminders.js";
import { externalSummary } from "./external-settings.js";
import { tidySummary } from "./tidy-settings.js";
import { h } from "./dom.js";
import { pickButton } from "./menu.js";
import { isAndroidApp, isNativeApp, privacyPlugin } from "../platform.js";
import { lockSummary } from "../core/app-lock.js";
import { fullDate } from "./format.js";
import "./app-lock-settings.js";
import "./backup.js";

export const FLAVORS = { system: "System", latte: "Latte", frappe: "Frappé", macchiato: "Macchiato", mocha: "Mocha" };

/** Opens the settings, or with `page` one of its pages ("reminders", "links") on top of them. */
export function openSettings(page) {
  openPanel("settings");
  if (page) go({ reminders: "settingsReminders", tidy: "settingsTidy", links: "settingsLinks", lock: "settingsLock", backup: "settingsBackup" }[page]);
}

// "About": version, licenses, the legal pages (static pages next to the app) and the source code.
function aboutCard() {
  const { version, source } = appInfo();
  preloadLicenses();
  return h("ul", { class: "sheet-card" },
    row({ icon: "info", title: "Version", sub: version || "Development build" }),
    row({ icon: "doc", title: "Open-source licenses", sub: licenseCount(), open: () => go("settingsLicenses") }),
    row({ icon: "protect", title: "Privacy policy", href: legalUrl("privacy") }),
    row({ icon: "doc", title: "Terms of use", href: legalUrl("terms") }),
    row({ icon: "code", title: "Source code", sub: source.replace(/^https?:\/\//, ""), href: source, newTab: true }));
}

/** Switches the Privacy section's two device options: stored, and pushed to the native side (which applies
 *  them before the web code loads, so it must stay in step). */
function setPrivacy(patch) {
  const privacy = { ...state.settings.privacy, ...patch };
  updateSettings({ privacy });
  if (isNativeApp()) privacyPlugin().set(patch).catch(() => {});
}

// Where dictation is recognized (Android only; on the web the browser decides).
const SPEECH_LABELS = { device: "On this device", online: "Online" };
const SPEECH_SUBS = {
  device: "Recordings never leave the phone (Android 12 or later)",
  online: "Your phone's speech service may send recordings to its servers",
};

/** The Privacy section, in the Android app only (the web has no screen lock to use). */
function privacySection() {
  if (!isAndroidApp()) return [];
  const { screenSecurity, incognitoKeyboard } = state.settings.privacy;
  const toggle = (label, sub, checked, onchange) =>
    h("label", { class: "setting-row" },
      h("span", { class: "setting-text" }, h("span", { class: "setting-label" }, label), h("span", { class: "setting-sub" }, sub)),
      h("input", { type: "checkbox", class: "switch", role: "switch", checked, onchange: e => onchange(e.target.checked) }));
  return [
    section("Privacy"),
    h("ul", { class: "sheet-card" },
      row({ icon: "lock", title: "Screen lock", sub: lockSummary(state.settings.lock), open: () => go("settingsLock") })),
    toggle("Screen security", "Hides NoteDown in recent apps and blocks screenshots", screenSecurity, v => setPrivacy({ screenSecurity: v })),
    toggle("Incognito keyboard", "Asks the keyboard not to learn from what you type", incognitoKeyboard, v => setPrivacy({ incognitoKeyboard: v })),
    h("div", { class: "setting-row" },
      h("span", { class: "setting-text" }, h("span", { class: "setting-label" }, "Speech recognition"),
        h("span", { class: "setting-sub" }, SPEECH_SUBS[state.settings.dictation])),
      pickButton(state.settings.dictation, Object.entries(SPEECH_LABELS), v => { updateSettings({ dictation: v }); refreshPage({ keepScroll: true }); },
        { cls: "ext-select", label: "Speech recognition" })),
  ];
}

const backupSub = () => state.settings.lastBackup
  ? `Encrypted file · last backup ${fullDate(state.settings.lastBackup)}` : "Encrypted file to save where you like";

registerPage("settings", {
  title: "Settings",
  render: () => [
    section("Appearance"),
    h("div", { class: "setting-row" }, h("span", { class: "setting-label" }, "Theme"),
      pickButton(state.settings.flavor, Object.entries(FLAVORS), v => { updateSettings({ flavor: v }); refreshPage({ keepScroll: true }); }, { cls: "ext-select", label: "Theme" })),
    section("Notes"),
    h("ul", { class: "sheet-card" },
      row({ icon: "bell", title: "Reminders", sub: reminderSummary(), open: () => go("settingsReminders") }),
      row({ icon: "sort", title: "Tidy-up reminder", sub: tidySummary(), open: () => go("settingsTidy") }),
      row({ icon: "link", title: "Links & media", sub: externalSummary(), open: () => go("settingsLinks") })),
    ...privacySection(),
    section("Sync"),
    h("ul", { class: "sheet-card" },
      row({ icon: "cloud", title: "Sync & sharing", sub: state.sync.enabled ? statusText() : "Off", open: () => { go(state.sync.enabled ? "overview" : "off"); syncOnRequest(); } })),
    section("Data"),
    h("ul", { class: "sheet-card" },
      row({ icon: "protect", title: "Backup", sub: backupSub(), open: () => go("settingsBackup") }),
      row({ icon: "restore", title: "Import from Google Keep", sub: "From a Google Takeout ZIP file", open: () => { location.href = legalUrl("import"); } })),
    section("About"),
    aboutCard(),
  ],
});

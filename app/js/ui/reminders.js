// Due-date reminders (backlog #1): the "Reminders" page of the settings,
// turning them on (asks for notification permission) and delivering them —
// in the Android app as local notifications scheduled on the device, so they
// come while the app is closed; on the web by a timer while the app is open
// (the browser can't wake a closed web app without push).
import { Capacitor, registerPlugin } from "../../vendor/capacitor-core.esm.js";
import { pickButton } from "./menu.js";
import { state, allNotes, updateSettings, subscribe } from "../store.js";
import { DEFAULT_REMINDERS, REMINDER_SHOW, reminderSchedule } from "../core/reminders.js";
import { showSnackbar } from "./snackbar.js";
import { registerPage, refreshPage } from "./sync-panel.js";
import { h } from "./dom.js";

const $ = id => document.getElementById(id);
const Native = Capacitor.isNativePlatform() ? registerPlugin("LocalNotifications") : null;
const NATIVE_MAX = 60;  // scheduled days ahead; re-planned at every change and app start
let onOpen = () => {};
let timer = null;
let noticeTimer = null;

const reminders = () => ({ ...DEFAULT_REMINDERS, ...state.settings.reminders });

async function setRemindersOn(on) {
  if (on && !(await askPermission())) {
    showSnackbar(Native ? "Notifications are blocked. Allow them in the app settings." : "Notifications are blocked. Allow them in the browser settings.");
    return;
  }
  updateSettings({ reminders: { ...reminders(), on } });
  if (on) showSnackbar(`Reminders on, daily at ${reminders().time}` + (Native ? "" : " while NoteDown is open"));
}

async function askPermission() {
  if (Native) return (await Native.requestPermissions()).display === "granted";
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  // The sample (?sample) simulates the platform: permission counts as given.
  if (state.sync.simulated) return true;
  return (await Notification.requestPermission()) === "granted";
}

// Re-planned whenever notes or the setting change (debounced: edits come per keystroke).
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(Native ? scheduleNative : scheduleWeb, Native ? 1000 : 0);
}

// Android: one local notification per due day; the id is the day (20261014).
async function scheduleNative() {
  const { notifications } = await Native.getPending();
  if (notifications.length) await Native.cancel({ notifications: notifications.map(n => ({ id: n.id })) });
  const r = reminders();
  if (!r.on) return;
  const list = reminderSchedule(allNotes(), r.time, new Date(), r.show).slice(0, NATIVE_MAX);
  if (!list.length) return;
  await Native.schedule({
    notifications: list.map(x => ({
      id: Number(x.day.replaceAll("-", "")), title: x.title, body: x.body, largeBody: x.body,
      schedule: { at: x.at, allowWhileIdle: true }, extra: { ids: x.ids },
      // Status-bar icon: a white silhouette from scripts/make-icons.js (backlog #26).
      smallIcon: "ic_stat_notedown", iconColor: "#8839ef",
    })),
  });
}

// Web: one timer for the next reminder.
function scheduleWeb() {
  const r = reminders();
  if (!r.on) return;
  const next = reminderSchedule(allNotes(), r.time, new Date(), r.show)[0];
  if (!next) return;
  // setTimeout can't wait longer than ~24 days; it re-plans when it wakes early.
  const wait = Math.min(next.at - Date.now(), 2 ** 31 - 1);
  timer = setTimeout(() => { if (Date.now() >= next.at) deliverWeb(next); scheduleWeb(); }, wait);
}

function deliverWeb(r) {
  if ("Notification" in window && Notification.permission === "granted") {
    const n = new Notification(r.title, { body: r.body, icon: "icons/icon-192.png", tag: "due-" + r.day });
    n.onclick = () => { window.focus(); n.close(); onOpen(r.ids); };
  } else {
    showNotice(r);
  }
}

function showNotice(r) {
  const el = $("reminderNotice");
  $("noticeTitle").textContent = r.title;
  $("noticeBody").textContent = r.body;
  el.onclick = () => { hideNotice(); onOpen(r.ids); };
  el.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(hideNotice, 10000);
}

function hideNotice() {
  clearTimeout(noticeTimer);
  $("reminderNotice").hidden = true;
}

/** The settings overview's line for reminders: "Off" or "Daily at 09:00". */
export const reminderSummary = () => reminders().on ? `Daily at ${reminders().time}` : "Off";

// Settings → Reminders (ui/settings.js).
registerPage("settingsReminders", {
  title: "Reminders",
  render: () => {
    const r = reminders();
    return [
      h("p", { class: "sheet-text" }, "On the due day, one notification lists the open notes due that day."),
      h("label", { class: "setting-row" }, h("span", { class: "setting-label" }, "Remind me of due notes"),
        h("input", { type: "checkbox", class: "switch", role: "switch", checked: r.on,
          onchange: async e => { await setRemindersOn(e.target.checked); refreshPage({ keepScroll: true }); } })),
      h("label", { class: "setting-row" + (r.on ? "" : " off") }, h("span", { class: "setting-label" }, "Time of day"),
        h("input", { type: "time", class: "time-input", value: r.time, disabled: !r.on,
          onchange: e => { if (e.target.value) updateSettings({ reminders: { ...reminders(), time: e.target.value } }); } })),
      h("div", { class: "setting-row" + (r.on ? "" : " off") }, h("span", { class: "setting-label" }, "Show in reminders"),
        Object.assign(pickButton(r.show, REMINDER_SHOW, v => { updateSettings({ reminders: { ...reminders(), show: v } }); refreshPage({ keepScroll: true }); }, { cls: "ext-select", label: "Show in reminders" }), { disabled: !r.on })),
      r.show === "titles" && h("p", { class: "sheet-text muted" }, "Titles show on the lock screen, and Android keeps them unencrypted until the reminder is due."),
      h("p", { class: "sheet-text muted" }, Native ? "Reminders come even when NoteDown is closed."
        : "In the browser, reminders only come while NoteDown is open. The Android app reminds you even when it's closed."),
    ];
  },
});

/** `open(ids)` is called when a reminder is tapped (it opens the Due page). */
export function initReminders({ open }) {
  onOpen = open;
  Native?.addListener("localNotificationActionPerformed", e => onOpen(e.notification.extra?.ids || []));
  subscribe(kind => { if (kind !== "sync") schedule(); });
  schedule();
}

// Due-date reminders (backlog #1): turning them on (asks for notification
// permission), the time of day, and delivering them — on the web a timer
// while the app is open (the browser can't wake a closed web app without
// push), in the Android app local notifications scheduled on the device.
// Prototype: ⋮ → Prototype → "Simulate reminder" shows the notification as a
// banner, so screenshots can show it.
import { state, allNotes, updateSettings, subscribe } from "../store.js";
import { DEFAULT_REMINDERS, reminderSchedule, reminderText } from "../core/reminders.js";
import { today } from "./format.js";
import { showSnackbar } from "./snackbar.js";

const $ = id => document.getElementById(id);
const native = false; // the Android app's local notifications follow once the setting's place is decided
let onOpen = () => {};
let timer = null;
let noticeTimer = null;

export const reminders = () => ({ ...DEFAULT_REMINDERS, ...state.settings.reminders });
export const webOnlyHint = "In the browser, reminders only come while NoteDown is open. The Android app reminds you even when it's closed.";

/** Turns reminders on (after the platform's permission prompt) or off. */
export async function setRemindersOn(on) {
  if (on && !(await askPermission())) {
    showSnackbar("Notifications are blocked. Allow them in the browser settings.");
    return false;
  }
  updateSettings({ reminders: { ...reminders(), on } });
  if (on) showSnackbar(`Reminders on, daily at ${reminders().time}` + (native ? "" : " while NoteDown is open"));
  return true;
}

export function setReminderTime(time) {
  if (time) updateSettings({ reminders: { ...reminders(), time } });
}

/** Opens the native time picker of the hidden input (menu variants). */
export function pickReminderTime() {
  const input = $("reminderTime");
  input.value = reminders().time;
  try { input.showPicker(); } catch { input.focus(); input.click(); }
}

async function askPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  // The sample (?sample) simulates the platform: permission counts as given.
  if (state.sync.simulated) return true;
  return (await Notification.requestPermission()) === "granted";
}

// Web: one timer for the next reminder, set again whenever notes or the setting change.
function schedule() {
  clearTimeout(timer);
  const r = reminders();
  if (!r.on) return;
  const next = reminderSchedule(allNotes(), r.time)[0];
  if (!next) return;
  // setTimeout can't wait longer than ~24 days; it re-plans when it wakes early.
  const wait = Math.min(next.at - Date.now(), 2 ** 31 - 1);
  timer = setTimeout(() => { if (Date.now() >= next.at) deliver(next); schedule(); }, wait);
}

function deliver(r) {
  if ("Notification" in window && Notification.permission === "granted") {
    const n = new Notification(r.title, { body: r.body, icon: "icons/icon-192.png", tag: "due-" + r.day });
    n.onclick = () => { window.focus(); n.close(); onOpen(r.ids); };
  } else {
    showNotice(r);
  }
}

/** Prototype: today's reminder as a banner that looks like the system notification. */
export function simulateReminder() {
  const notes = allNotes().filter(n => n.status === "open" && n.due === today());
  if (!notes.length) return showSnackbar("No open notes due today");
  showNotice({ ids: notes.map(n => n.id), ...reminderText(notes) });
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

// Variant A: ⋮ → "Reminders…" opens a small dialog with a switch and the time.
export function openReminderDialog() {
  renderDialog();
  $("reminderDialog").hidden = false;
  $("reminderDone").focus({ preventScroll: true, focusVisible: false });
}

function renderDialog() {
  const r = reminders();
  $("reminderOn").checked = r.on;
  $("reminderTimeRow").classList.toggle("off", !r.on);
  $("reminderTimeInput").value = r.time;
  $("reminderTimeInput").disabled = !r.on;
}

const closeDialog = () => { $("reminderDialog").hidden = true; };

/** `open(ids)` shows the notes a tapped reminder lists. */
export function initReminders({ open }) {
  onOpen = open;
  $("reminderTime").addEventListener("change", e => setReminderTime(e.target.value));
  $("reminderHint").textContent = webOnlyHint;
  $("reminderOn").addEventListener("change", async e => { await setRemindersOn(e.target.checked); renderDialog(); });
  $("reminderTimeInput").addEventListener("change", e => setReminderTime(e.target.value));
  $("reminderDone").addEventListener("click", closeDialog);
  $("reminderDialog").addEventListener("click", e => { if (e.target === $("reminderDialog")) closeDialog(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("reminderDialog").hidden) { e.stopPropagation(); closeDialog(); } }, true);
  subscribe(kind => { if (kind !== "sync") schedule(); });
  schedule();
}

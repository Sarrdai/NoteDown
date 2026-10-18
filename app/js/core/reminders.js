// Due-date reminders (backlog #1): one notification per due day, at one
// time of day set on this device, for the open notes due that day.
// Pure logic; the platforms (web timer, Android local notifications) live in
// ui/reminders.js.
import { noteTitle } from "./markdown.js";
import { refOf } from "./note-ref.js";

// `show`: what a reminder says (backlog #57, as Signal's notification content): "count" only how many notes
// are due — the default, since a notification shows on the lock screen and Android keeps a scheduled one's text
// unencrypted until it is due — or "titles", their titles too.
export const DEFAULT_REMINDERS = { on: false, time: "09:00", show: "count" };

export const REMINDER_SHOW = [["count", "Only the number"], ["titles", "Note titles"]];

/** "YYYY-MM-DD" + "HH:MM" → that moment in the device's local time. */
export function reminderAt(day, time) {
  const [y, m, d] = day.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  return new Date(y, m - 1, d, h, min);
}

/** The notification for a day's notes: { title: "2 notes due today", body: one title per line, or with
 *  `show` "count" a line without note text }. */
export function reminderText(notes, show = DEFAULT_REMINDERS.show) {
  return {
    title: notes.length === 1 ? "1 note due today" : `${notes.length} notes due today`,
    body: show === "titles" ? notes.map(n => noteTitle(n.body).text).join("\n") : "Tap to open NoteDown.",
  };
}

/**
 * The reminders still ahead: one per due day of the open notes whose time
 * has not passed yet, soonest first — [{ day, at: Date, ids, title, body }].
 */
export function reminderSchedule(notes, time, now = new Date(), show = DEFAULT_REMINDERS.show) {
  const byDay = new Map();
  for (const n of notes) {
    if (n.status === "closed" || n.deleted || !n.due) continue;
    if (!byDay.has(n.due)) byDay.set(n.due, []);
    byDay.get(n.due).push(n);
  }
  return [...byDay.entries()]
    .map(([day, list]) => ({ day, at: reminderAt(day, time), ids: list.map(refOf), ...reminderText(list, show) }))
    .filter(r => r.at > now)
    .sort((a, b) => a.at - b.at);
}

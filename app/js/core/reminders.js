// Due-date reminders (backlog #1): one notification per due day, at one
// time of day set on this device, for the open notes due that day.
// Pure logic; the platforms (web timer, Android local notifications) live in
// ui/reminders.js.
import { noteTitle } from "./markdown.js";

export const DEFAULT_REMINDERS = { on: false, time: "09:00" };

/** "YYYY-MM-DD" + "HH:MM" → that moment in the device's local time. */
export function reminderAt(day, time) {
  const [y, m, d] = day.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  return new Date(y, m - 1, d, h, min);
}

/** The notification for a day's notes: { title: "2 notes due today", body: one title per line }. */
export function reminderText(notes) {
  return {
    title: notes.length === 1 ? "1 note due today" : `${notes.length} notes due today`,
    body: notes.map(n => noteTitle(n.body).text).join("\n"),
  };
}

/**
 * The reminders still ahead: one per due day of the open notes whose time
 * has not passed yet, soonest first — [{ day, at: Date, ids, title, body }].
 */
export function reminderSchedule(notes, time, now = new Date()) {
  const byDay = new Map();
  for (const n of notes) {
    if (n.status === "closed" || n.deleted || !n.due) continue;
    if (!byDay.has(n.due)) byDay.set(n.due, []);
    byDay.get(n.due).push(n);
  }
  return [...byDay.entries()]
    .map(([day, list]) => ({ day, at: reminderAt(day, time), ids: list.map(n => n.id), ...reminderText(list) }))
    .filter(r => r.at > now)
    .sort((a, b) => a.at - b.at);
}

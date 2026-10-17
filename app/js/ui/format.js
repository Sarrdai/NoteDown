// Date labels for the list. Inputs are the file's timestamps (UTC, shown
// in the device's local time) and dates ("YYYY-MM-DD", calendar days).
import { localTime } from "../core/notes-file.js";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function today(now = new Date()) {
  return localDay(now);
}

function localDay(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDays(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  return localDay(new Date(y, m - 1, d + n));
}

export function shortDate(day, now = new Date()) {
  const [y, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}` + (String(y) === today(now).slice(0, 4) ? "" : ` ${y}`);
}

/** "Today 08:40", "Yesterday 19:22", "12 Oct", "12 Oct 2025". */
export function relativeTime(ts, now = new Date()) {
  ts = localTime(ts);
  const day = ts.slice(0, 10);
  const time = ts.slice(11, 16);
  const t = today(now);
  if (day === t) return `Today ${time}`;
  if (day === addDays(t, -1)) return `Yesterday ${time}`;
  return shortDate(day, now);
}

/** "17 Oct 2026, 14:05": a UTC timestamp in the device's local time, with the year. */
export function fullDate(ts) {
  const t = localTime(ts);
  const [y, m, d] = t.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}, ${t.slice(11, 16)}`;
}

/** Due chip: { text, kind: "overdue" | "today" | "future" }. */
export function dueLabel(due, now = new Date()) {
  const t = today(now);
  if (due < t) return { text: `Overdue · ${shortDate(due, now)}`, kind: "overdue" };
  if (due === t) return { text: "Due today", kind: "today" };
  if (due === addDays(t, 1)) return { text: "Due tomorrow", kind: "future" };
  return { text: `Due ${shortDate(due, now)}`, kind: "future" };
}

export { addDays };

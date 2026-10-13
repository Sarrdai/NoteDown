// Date labels for the list. Inputs are the file's local timestamps
// ("YYYY-MM-DDTHH:MM") and dates ("YYYY-MM-DD").
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
  const day = ts.slice(0, 10);
  const time = ts.slice(11, 16);
  const t = today(now);
  if (day === t) return `Today ${time}`;
  if (day === addDays(t, -1)) return `Yesterday ${time}`;
  return shortDate(day, now);
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

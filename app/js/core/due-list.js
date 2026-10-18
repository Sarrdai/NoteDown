// The Due view (backlog #65): everything that is due, item by item — the open notes' own due dates and the
// open tasks' dates (core/task-due.js) — grouped by how soon. Pure logic; the page is ui/due.js.
import { tasks, noteTitle } from "./markdown.js";
import { lineDue, DUE_AT_END } from "./task-due.js";
import { refOf } from "./note-ref.js";

export const DUE_GROUPS = [["overdue", "Overdue"], ["today", "Today"], ["soon", "Next 7 days"], ["later", "Later"]];

/** "YYYY-MM-DD" plus `n` days. */
function addDays(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** A task line's text without list marker, checkbox and trailing date. */
function taskText(line) {
  return line.replace(DUE_AT_END, "").replace(/^\s*(?:[-*+]|\d+[.)])\s+\[[ xX/-]\]\s+/, "").trim();
}

/**
 * Everything due in the notes that are not closed or deleted: one { kind: "note", id, day } for a note's own
 * due date, one { kind: "task", id, index, day, text } per open or in-progress task whose line carries a date.
 * `today` is unused for filtering (overdue items stay) and kept so callers pass one clock throughout.
 */
export function dueItems(notes, today) {
  const items = [];
  for (const n of notes) {
    if (n.status === "closed" || n.deleted) continue;
    const id = refOf(n);
    if (n.due) items.push({ kind: "note", id, day: n.due });
    const lines = n.body.split("\n");
    tasks(n.body).forEach((t, index) => {
      if (t.state !== "open" && t.state !== "doing") return;
      const day = lineDue(lines[t.line]);
      if (day) items.push({ kind: "task", id, index, day, text: taskText(lines[t.line]) });
    });
  }
  return items;
}

/** The group key of a day: overdue, today, soon (tomorrow … today + 7) or later. */
export function groupOf(day, today) {
  if (day < today) return "overdue";
  if (day === today) return "today";
  return day <= addDays(today, 7) ? "soon" : "later";
}

/** The items as [{ key, title, items }] — overdue, today, next 7 days, later; empty groups left out. Within a
 *  group by day, notes before tasks, then by note title, then by task index. */
export function dueGroups(items, today, titleOf = () => "") {
  const byKey = new Map(DUE_GROUPS.map(([key]) => [key, []]));
  for (const it of items) byKey.get(groupOf(it.day, today)).push(it);
  const order = (a, b) => a.day.localeCompare(b.day)
    || (a.kind === b.kind ? 0 : a.kind === "note" ? -1 : 1)
    || titleOf(a.id).localeCompare(titleOf(b.id))
    || (a.index ?? 0) - (b.index ?? 0);
  return DUE_GROUPS.map(([key, title]) => ({ key, title, items: byKey.get(key).sort(order) })).filter(g => g.items.length);
}

/** How many items are overdue or due today (the badge). */
export function dueNowCount(items, today) {
  return items.filter(it => it.day <= today).length;
}

/** The title of a note for sorting and the "in …" line. */
export const titleOfNotes = notes => {
  const byId = new Map(notes.map(n => [refOf(n), noteTitle(n.body).text]));
  return id => byId.get(id) || "";
};

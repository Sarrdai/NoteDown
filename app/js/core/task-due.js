// Due dates per task (backlog #41): the Obsidian Tasks syntax, a `📅 YYYY-MM-DD`
// at the end of a task's line (docs/file-format.md). The rendered note shows it
// as a chip (core/markdown.js, ui/note-list.js); its menu sets it here.
import { tasks, TASK_LINE } from "./markdown.js";

/** The date at the end of a line: "📅 2026-10-20" (the emoji may carry its variation selector). */
export const DUE_AT_END = /[ \t]*📅️?[ \t]?(\d{4}-\d{2}-\d{2})[ \t]*$/;

/** A line's task due date, or null (also null on a line that is no task). */
export function lineDue(line) {
  if (!TASK_LINE.test(line)) return null;
  const m = DUE_AT_END.exec(line);
  return m ? m[1] : null;
}

/** Sets (`due` "YYYY-MM-DD") or removes (`due` null) the date at the end of a line. */
export function setLineDue(line, due) {
  const rest = line.replace(DUE_AT_END, "").trimEnd();
  return due ? `${rest} 📅 ${due}` : rest;
}

/** The due date of the n-th task (0-based, document order as core/markdown.js → tasks), or null. */
export function taskDue(body, index) {
  const t = tasks(body)[index];
  return t ? lineDue(body.split("\n")[t.line]) : null;
}

/** Sets or removes the due date of the n-th task in the source. */
export function setTaskDue(body, index, due) {
  const t = tasks(body)[index];
  if (!t) return body;
  const lines = body.split("\n");
  lines[t.line] = setLineDue(lines[t.line], due);
  return lines.join("\n");
}

// Open and in-progress tasks carry their date into the note (decided 2026-10-18); done and cancelled ones don't.
function openTaskDues(n) {
  const lines = n.body.split("\n");
  return tasks(n.body).filter(t => t.state === "open" || t.state === "doing").map(t => lineDue(lines[t.line])).filter(Boolean);
}

/** The date a note sorts by under "Due date": the earliest of its own due date and its open tasks' dates, or null. */
export function noteDue(n) {
  return [n.due, ...openTaskDues(n)].filter(Boolean).sort()[0] || null;
}

/** Every day a note is due on (its own due date and its open tasks' dates), for the reminders; sorted, no repeats. */
export function noteDueDays(n) {
  return [...new Set([n.due, ...openTaskDues(n)].filter(Boolean))].sort();
}

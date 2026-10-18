// Unit tests for due dates per task (app/js/core/task-due.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNotesFile } from "../app/js/core/notes-file.js";
import { renderMarkdown, tasks } from "../app/js/core/markdown.js";
import { lineDue, setLineDue, taskDue, setTaskDue, noteDue, noteDueDays } from "../app/js/core/task-due.js";
import { sortNotes } from "../app/js/core/query.js";
import { reminderSchedule } from "../app/js/core/reminders.js";
import { clearDone } from "../app/js/core/tasks.js";

const { notes } = parseNotesFile(readFileSync(new URL("../app/sample/notes.md", import.meta.url), "utf8"));
const body = id => notes.find(n => n.id === id).body;
const index = (b, text) => tasks(b).findIndex(t => b.split("\n")[t.line].includes(text));

test("lineDue reads the date at the end of a task line only", () => {
  assert.equal(lineDue("- [ ] Winter tyres 📅 2026-10-24"), "2026-10-24");
  assert.equal(lineDue("- [x] Winter tyres 📅️ 2026-10-24  "), "2026-10-24");
  assert.equal(lineDue("- Winter tyres 📅 2026-10-24"), null);
  assert.equal(lineDue("- [ ] Winter tyres 📅 2026-10-24 later"), null);
});

test("setLineDue adds, replaces and removes the date", () => {
  assert.equal(setLineDue("- [ ] Winter tyres", "2026-10-24"), "- [ ] Winter tyres 📅 2026-10-24");
  assert.equal(setLineDue("- [ ] Winter tyres 📅 2026-10-24", "2026-11-01"), "- [ ] Winter tyres 📅 2026-11-01");
  assert.equal(setLineDue("- [ ] Winter tyres 📅 2026-10-24", null), "- [ ] Winter tyres");
});

test("taskDue and setTaskDue address a task by its index in the note", () => {
  const b = body("s12");
  assert.equal(taskDue(b, index(b, "Winter tyres")), body("s12").match(/📅 (\S+)/)[1]);
  const i = index(b, "Inspection sticker");
  assert.equal(taskDue(b, i), null);
  const set = setTaskDue(b, i, "2026-10-31");
  assert.equal(taskDue(set, i), "2026-10-31");
  assert.equal(setTaskDue(set, i, null), b);
  assert.equal(setTaskDue(b, 99, "2026-10-31"), b);
});

test("a task's date renders as a chip; elsewhere it stays text", () => {
  const html = renderMarkdown(body("s12"));
  assert.match(html, /<button type="button" class="chip task-due" data-due="2026-10-24">/);
  assert.equal(renderMarkdown("Winter tyres 📅 2026-10-24").includes("task-due"), false);
  assert.equal(renderMarkdown("- [ ] `x 📅 2026-10-24`").includes("task-due"), false);
});

test("a note is due by its own date or its earliest open task date", () => {
  const n = notes.find(x => x.id === "s04");   // its own due date and an open task with a date
  const days = [n.due, n.body.match(/📅 (\S+)/)[1]].sort();
  assert.equal(noteDue(n), days[0]);
  assert.deepEqual(noteDueDays(n), days);
  const done = { ...n, body: n.body.replace("- [ ] Find the donation receipts", "- [x] Find the donation receipts") };
  assert.equal(noteDue(done), n.due);
  assert.equal(noteDue({ ...n, due: null }), days.find(d => d !== n.due));
});

test("sorting by due date and the reminders count open task dates", () => {
  const car = { ...notes.find(x => x.id === "s12"), due: null };   // only a task date
  const other = { ...notes.find(x => x.id === "s02") };
  const sorted = sortNotes([other, car], { key: "due", dir: "asc" });
  assert.equal(sorted[0].id, noteDue(car) < other.due ? "s12" : "s02");
  const taskDay = noteDue(car);
  const schedule = reminderSchedule([car], "09:00", new Date(2000, 0, 1));
  assert.deepEqual(schedule.map(r => r.day), [taskDay]);
});

test("Clear done tasks takes a dated done task along with its date", () => {
  const b = setTaskDue(body("s12").replace("- [ ] Winter tyres", "- [x] Winter tyres"), 0, "2026-10-24");
  const r = clearDone(b, [{ whole: true }]);
  assert.match(r.done, /- \[x\] Winter tyres 📅 2026-10-24/);
  assert.ok(!r.body.includes("Winter tyres"));
});

test("a done date after the due date: the due date still counts, setLineDue keeps the done date last", () => {
  assert.equal(lineDue("- [x] Winter tyres 📅 2026-10-24 ✅ 2026-10-18"), "2026-10-24");
  assert.equal(setLineDue("- [x] Winter tyres 📅 2026-10-24 ✅ 2026-10-18", "2026-10-30"), "- [x] Winter tyres 📅 2026-10-30 ✅ 2026-10-18");
  assert.equal(setLineDue("- [x] Winter tyres ✅ 2026-10-18", "2026-10-30"), "- [x] Winter tyres 📅 2026-10-30 ✅ 2026-10-18");
  assert.equal(setLineDue("- [x] Winter tyres 📅 2026-10-24 ✅ 2026-10-18", null), "- [x] Winter tyres ✅ 2026-10-18");
});

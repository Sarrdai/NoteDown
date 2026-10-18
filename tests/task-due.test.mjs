// Unit tests for due dates per task (app/js/core/task-due.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNotesFile } from "../app/js/core/notes-file.js";
import { renderMarkdown, tasks } from "../app/js/core/markdown.js";
import { lineDue, setLineDue, taskDue, setTaskDue } from "../app/js/core/task-due.js";

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

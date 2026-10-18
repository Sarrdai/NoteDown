// "Done today" (docs/requirements.md → "Due view"): ticking writes a done date, the Due button's ring counts it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTaskState, toggleTask, doneTasksOn, renderMarkdown } from "../app/js/core/markdown.js";
import { doneOn } from "../app/js/core/query.js";

const body = "## Weekly groceries\n- [ ] Oat milk\n- [ ] Coffee beans 📅 2026-10-18\n- [x] Dishwasher tablets";

test("ticking with a day writes the done date, unticking drops it", () => {
  const ticked = toggleTask(body, 1, "2026-10-18");
  assert.equal(ticked.split("\n")[2], "- [x] Coffee beans 📅 2026-10-18 ✅ 2026-10-18");
  assert.equal(toggleTask(ticked, 1, "2026-10-18"), body);
  assert.equal(toggleTask(body, 0), body.replace("[ ] Oat", "[x] Oat"));   // no day: no date
});

test("a done date stays when the task is set done again; other states drop it", () => {
  const ticked = setTaskState(body, 0, "done", "2026-10-17");
  assert.equal(setTaskState(ticked, 0, "done", "2026-10-18"), ticked);
  assert.equal(setTaskState(ticked, 0, "doing", "2026-10-18").split("\n")[1], "- [/] Oat milk");
  assert.equal(setTaskState(ticked, 0, "cancelled").split("\n")[1], "- [-] Oat milk");
});

test("doneTasksOn counts done tasks with that day's done date only", () => {
  const b = toggleTask(toggleTask(body, 0, "2026-10-18"), 1, "2026-10-17");
  assert.equal(doneTasksOn(b, "2026-10-18"), 1);
  assert.equal(doneTasksOn(b, "2026-10-17"), 1);
  assert.equal(doneTasksOn("- [ ] Milk ✅ 2026-10-18", "2026-10-18"), 0);   // not done
});

test("doneOn adds notes closed and tasks ticked that day, not in deleted notes", () => {
  const notes = [
    { id: "a", status: "closed", closed: "2026-10-18T09:00:00", body: "Pay the bill" },
    { id: "b", status: "open", body: "- [x] Milk ✅ 2026-10-18\n- [x] Bread ✅ 2026-10-18" },
    { id: "c", status: "open", deleted: "2026-10-18T10:00:00", body: "- [x] Tea ✅ 2026-10-18" },
  ];
  assert.equal(doneOn(notes, "2026-10-18"), 3);
  assert.equal(doneOn(notes, "2026-10-19"), 0);
});

test("the done date is hidden at the end of a task's first line, the due chip still shows", () => {
  const html = renderMarkdown("- [x] Winter tyres 📅 2026-10-24 ✅ 2026-10-18");
  assert.ok(!html.includes("✅"));
  assert.ok(html.includes('class="chip task-due" data-due="2026-10-24"'));
  assert.ok(renderMarkdown("Ticked ✅ 2026-10-18 here").includes("✅"));
});

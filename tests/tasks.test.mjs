// Unit tests for task progress and clearing done tasks (app/js/core/tasks.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNotesFile } from "../app/js/core/notes-file.js";
import { sections } from "../app/js/core/markdown.js";
import { countDone, clearDone, returnDone, sectionProgress } from "../app/js/core/tasks.js";

const { notes } = parseNotesFile(readFileSync(new URL("../app/sample/notes.md", import.meta.url), "utf8"));
const body = id => notes.find(n => n.id === id).body;
const whole = [{ whole: true }];
const section = (b, text) => { const i = sections(b).findIndex(s => s.text === text); return [{ from: i, to: i + 1, whole: false }]; };

test("clearDone takes the ticked tasks out of a whole note, under its title", () => {
  const r = clearDone(body("s01"), whole);
  assert.equal(r.count, 1);
  assert.equal(r.done, "## Weekly groceries\n- [x] Oat milk ✅ 2026-10-13");
  assert.ok(!r.body.includes("Oat milk"));
  assert.ok(r.body.startsWith("## Weekly groceries\n- [ ] Coffee beans"));
});

test("a ticked task takes its indented lines along; groups keep their section heading; cancelled tasks go too", () => {
  const r = clearDone(body("s03"), whole);
  assert.equal(r.count, 2);
  assert.equal(r.done, "## Trip to Lisbon\n\n### Before we go\n- [x] Book flights\n  - Seats 14A and 14B, return on Sunday evening"
    + "\n\n### Packing\n- [-] Power adapter? (no, same plug type)");
  assert.ok(!r.body.includes("Seats 14A"));
  assert.ok(r.body.includes("### Before we go\n- [ ] Reserve the apartment"));
});

test("selected sections only clear their own tasks", () => {
  const b = body("s03");
  assert.equal(countDone(b, section(b, "Things to see")), 0);
  assert.equal(countDone(b, section(b, "Before we go")), 1);
  assert.equal(clearDone(b, section(b, "Things to see")).count, 0);
  assert.equal(clearDone(b, section(b, "Packing")).count, 1);
});

test("returnDone puts the tasks back at the end of their section", () => {
  const b = body("s03");
  const r = clearDone(b, whole);
  const back = returnDone(r.body, r.done);
  assert.ok(back.includes("- [ ] Ask Tom for the restaurant list\n- [x] Book flights\n  - Seats 14A and 14B, return on Sunday evening\n### Things to see"));
  assert.equal(countDone(back, whole), 2);
});

test("a task in progress stays when done tasks are cleared", () => {
  const r = clearDone(body("s04"), whole);
  assert.ok(r.body.includes("- [/] Collect the craftsman invoices"));
});

test("sectionProgress counts each section with the headings below it, without cancelled tasks", () => {
  const b = body("s03");
  const p = sectionProgress(b);
  const at = text => p[sections(b).findIndex(s => s.text === text)];
  assert.deepEqual(at("Trip to Lisbon"), { done: 1, total: 4 });
  assert.deepEqual(at("Before we go"), { done: 1, total: 3 });
  assert.equal(at("Things to see"), null);
  assert.deepEqual(at("Packing"), { done: 0, total: 1 });
  // In progress counts as open; text before the first heading counts on its own.
  assert.deepEqual(sectionProgress(body("s04"))[0], { done: 1, total: 3 });
  assert.deepEqual(sectionProgress("- [x] Oat milk\n- [/] Coffee beans (the Ethiopian ones)\n## Weekly groceries\n- [ ] Dishwasher tablets"),
    [{ done: 1, total: 2 }, { done: 0, total: 1 }]);
});

test("returnDone appends tasks whose section is gone at the end of the note", () => {
  const r = clearDone(body("s04"), whole);
  assert.equal(r.done, "## Tax return 2025\n- [x] Download the annual bank statement");
  const back = returnDone("Find the donation receipts", r.done);
  assert.equal(back, "Find the donation receipts\n- [x] Download the annual bank statement");
});

test("a note of ticked tasks only is left empty", () => {
  const r = clearDone("- [x] Oat milk\n- [X] Book flights", whole);
  assert.equal(r.body, null);
  assert.equal(r.count, 2);
});

test("the archived note's link to its source survives the file format", async () => {
  const { serializeNotesFile } = await import("../app/js/core/notes-file.js");
  const archived = { ...notes.find(n => n.id === "s01"), id: "a1", status: "closed", closed: "2026-10-13T09:00Z", from: "s01" };
  const back = parseNotesFile(serializeNotesFile({ notes: [archived] })).notes[0];
  assert.equal(back.from, "s01");
});

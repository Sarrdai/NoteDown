// Unit tests for clearing done tasks (app/js/core/tasks.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNotesFile } from "../app/js/core/notes-file.js";
import { sections } from "../app/js/core/markdown.js";
import { countDone, clearDone, returnDone } from "../app/js/core/tasks.js";

const { notes } = parseNotesFile(readFileSync(new URL("../app/sample/notes.md", import.meta.url), "utf8"));
const body = id => notes.find(n => n.id === id).body;
const whole = [{ whole: true }];
const section = (b, text) => { const i = sections(b).findIndex(s => s.text === text); return [{ from: i, to: i + 1, whole: false }]; };

test("clearDone takes the ticked tasks out of a whole note, under its title", () => {
  const r = clearDone(body("s01"), whole);
  assert.equal(r.count, 1);
  assert.equal(r.done, "## Weekly groceries\n- [x] Oat milk");
  assert.ok(!r.body.includes("Oat milk"));
  assert.ok(r.body.startsWith("## Weekly groceries\n- [ ] Coffee beans"));
});

test("a ticked task takes its indented lines along; groups keep their section heading", () => {
  const r = clearDone(body("s03"), whole);
  assert.equal(r.count, 1);
  assert.equal(r.done, "## Trip to Lisbon\n\n### Before we go\n- [x] Book flights\n  - Seats 14A and 14B, return on Sunday evening");
  assert.ok(!r.body.includes("Seats 14A"));
  assert.ok(r.body.includes("### Before we go\n- [ ] Reserve the apartment"));
});

test("selected sections only clear their own tasks", () => {
  const b = body("s03");
  assert.equal(countDone(b, section(b, "Packing")), 0);
  assert.equal(countDone(b, section(b, "Before we go")), 1);
  assert.equal(clearDone(b, section(b, "Packing")).count, 0);
});

test("returnDone puts the tasks back at the end of their section", () => {
  const b = body("s03");
  const r = clearDone(b, whole);
  const back = returnDone(r.body, r.done);
  assert.ok(back.includes("- [ ] Ask Tom for the restaurant list\n- [x] Book flights\n  - Seats 14A and 14B, return on Sunday evening\n### Things to see"));
  assert.equal(countDone(back, whole), 1);
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

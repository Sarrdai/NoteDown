// Unit tests for Move to… (app/js/core/move.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createNote, parseNotesFile } from "../app/js/core/notes-file.js";
import { moveOutline, moveInto, asTasks, insertText } from "../app/js/core/move.js";

const n = (id, body) => createNote(body, "2026-10-05T09:00", id);
const byId = notes => Object.fromEntries(notes.map(x => [x.id, x]));
const sample = Object.fromEntries(parseNotesFile(readFileSync(new URL("../app/sample/notes.md", import.meta.url), "utf8")).notes.map(x => [x.id, x]));
const whole = id => ({ noteId: id, from: 0, to: 1, whole: true });

test("outline: one row per section; tasks where the section's own text ends with a task", () => {
  const rows = moveOutline(sample.s03.body);
  assert.deepEqual(rows.map(r => [r.text, r.depth, r.tasks]), [
    ["Trip to Lisbon", 2, false], ["Before we go", 3, true], ["Things to see", 3, false],
    ["Lisbon", 4, false], ["Sintra", 4, false], ["Packing", 3, true],
  ]);
  // The labels closing a note don't count as its last line.
  assert.equal(moveOutline(sample.s01.body)[0].tasks, true);
  assert.equal(moveOutline(sample.s02.body)[0].fromHeading, false);
});

test("as tasks: each paragraph one task, list items get a box", () => {
  assert.equal(asTasks("Buy a bell.\nThe old one is gone."), "- [ ] Buy a bell. The old one is gone.");
  assert.equal(asTasks("- a\n  - sub\n- [x] b\n\nc"), "- [ ] a\n  - sub\n- [x] b\n- [ ] c");
});

test("move: a dictated note joins the task list of a section, before its labels and subsections", () => {
  const notes = { ...byId([sample.s01, sample.s02]) };
  const m = moveInto(notes, [whole("s02")], "s01", 0, { asTask: true });
  assert.match(m.body, /- \[ \] Dishwasher tablets\n- \[ \] Remind Lea that the bike needs new brake pads[^\n]*squeaks\.\n\n#shopping$/);
  assert.deepEqual(m.changes, [{ id: "s02", body: null }]);
  // Into a section with subsections: at the end of its own text.
  const t = moveInto(byId([sample.s03, sample.s02]), [whole("s02")], "s03", 1, { asTask: true }).body;
  assert.match(t, /- \[ \] Ask Tom for the restaurant list\n- \[ \] Remind Lea[^\n]*\n### Things to see/);
});

test("move: as a paragraph it follows after a blank line", () => {
  const t = moveInto(byId([sample.s03, sample.s02]), [whole("s02")], "s03", 4).body;
  assert.match(t, /Pena Palace first, it gets crowded after 11\n\nRemind Lea[^\n]*\n### Packing/);
});

test("move: a part with headings becomes a subsection of the target section", () => {
  const t = n("t", "## T\nintro\n### T1\na");
  const s = n("s", "## S\nx\n### S1\ny\n## R\nz");
  const m = moveInto(byId([t, s]), [{ noteId: "s", from: 0, to: 2 }], "t", 1);
  assert.equal(m.body, "## T\nintro\n### T1\na\n\n#### S\nx\n##### S1\ny");
  assert.deepEqual(m.changes, [{ id: "s", body: "## R\nz" }]);
  // Right below a heading without text.
  const e = n("e", "## E\n### E1\nb");
  assert.equal(moveInto(byId([e, n("p", "Plain.")]), [whole("p")], "e", 0).body, "## E\nPlain.\n### E1\nb");
});

test("move: a section can move to another section of its own note", () => {
  const t = n("t", "## T\n### A\n- [ ] a\n### B\nThe b text.");
  const m = moveInto(byId([t]), [{ noteId: "t", from: 2, to: 3 }], "t", 1, { asTask: false });
  assert.equal(m.body, "## T\n### A\n- [ ] a\n\n#### B\nThe b text.");
  assert.deepEqual(m.changes, []);
});

test("copy to: a passage lands at the end of the section, as a task when wanted, before the labels", () => {
  const car = sample.s12.body;
  const passage = "  She said the front one squeaks.  ";
  assert.equal(insertText(car, 0, passage), car.replace("October\n\n#paperwork", "October\n\nShe said the front one squeaks.\n\n#paperwork"));
  assert.equal(insertText(car, 0, passage, { asTask: true }), car.replace("October\n\n#paperwork", "October\n- [ ] She said the front one squeaks.\n\n#paperwork"));
});

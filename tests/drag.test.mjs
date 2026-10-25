// Unit tests for drag and drop of list items and sections (app/js/core/drag.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNotesFile } from "../app/js/core/notes-file.js";
import { itemSlots, sectionSlots, sectionRange, moveItem, moveSection, moveParts } from "../app/js/core/drag.js";

const notes = parseNotesFile(readFileSync(new URL("../app/sample/notes.md", import.meta.url), "utf8")).notes;
const lisbon = notes.find(n => n.body.includes("Book flights")).body;
const lineOf = (body, text) => body.split("\n").findIndex(l => l.includes(text));
const levels = slot => slot.levels.map(l => l.indent);

test("item slots: between items with the levels an outliner allows, at a list's end, at a section's end", () => {
  const body = "Intro\n\n- a\n  - a1\n- b\n\nText";
  const slots = itemSlots(body);
  const at = line => slots.find(s => s.line === line);
  assert.deepEqual(levels(at(3)), [2]);           // before a1: only as a child of a
  assert.deepEqual(levels(at(4)), [0, 2, 4]);     // before b: beside a, beside a1, below a1
  assert.deepEqual(levels(at(5)), [0, 2]);        // after b (the list's end)
  assert.deepEqual(at(5).anchor, { after: 4 });
  assert.equal(slots.find(s => s.anchor.sectionEnd === 0).line, 7);
  assert.equal(slots.find(s => s.anchor.sectionEnd === 0).gap, true);
});

test("item slots: none inside the dragged item; lists apart stay apart", () => {
  const body = "- a\n  - a1\n- b\n\ntext\n\n- c";
  const lines = itemSlots(body, [0, 2]).map(s => s.line);
  assert.equal(lines.includes(1), false);
  assert.deepEqual(levels(itemSlots(body).find(s => s.line === 6)), [0]);   // c starts a list of its own
});

test("move item: within a list, its sub-items along, to another level", () => {
  const body = "- a\n  - a1\n- b\n- c";
  assert.equal(moveItem(body, [0, 2], 0, null, 3, 0).src, "- b\n- a\n  - a1\n- c");
  assert.equal(moveItem(body, [3, 4], 0, null, 1, 2).src, "- a\n  - c\n  - a1\n- b");
  assert.equal(moveItem(body, [1, 2], 2, null, 4, 0).src, "- a\n- b\n- c\n- a1");
});

test("move item: to the end of a section without a list, blank lines around it", () => {
  const body = "## A\n- x\n- y\n## B\nSome text.\n#travel";
  const slot = itemSlots(body, [2, 3]).find(s => s.anchor.sectionEnd === 1);
  assert.equal(moveItem(body, [2, 3], 0, null, slot.line, 0, { gap: true }).src, "## A\n- x\n## B\nSome text.\n\n- y\n\n#travel");
});

test("move item: into another note; a source left empty goes", () => {
  const groceries = notes.find(n => n.body.includes("Dishwasher tablets")).body;
  const line = lineOf(lisbon, "Ask Tom");
  const slot = itemSlots(groceries).find(s => s.anchor.after !== undefined);
  const m = moveItem(lisbon, [line, line + 1], 0, groceries, slot.line, 0);
  assert.equal(m.src.includes("Ask Tom"), false);
  assert.match(m.dst, /Dishwasher tablets\n- \[ \] Ask Tom for the restaurant list/);
  assert.equal(moveItem("- only", [0, 1], 0, "- x", 1, 0).src, null);
});

test("section slots: before headings, at the end, levels from the next heading to one below the previous", () => {
  const body = "## A\ntext\n### A1\nmore\n## B\nend";
  const slots = sectionSlots(body);
  assert.deepEqual(slots.map(s => [s.line, s.depths]), [[0, [2]], [2, [3]], [4, [2, 3, 4]], [6, [2, 3]]]);
  assert.deepEqual(sectionRange(body, 0), { lines: [0, 4], depth: 2 });
});

test("move section: with its subsections, its headings shifted to the new level", () => {
  const body = "## A\ntext\n### A1\nmore\n## B\nend";
  assert.equal(moveSection(body, [0, 4], 2, null, 6, 3).src, "## B\nend\n\n### A\ntext\n#### A1\nmore");
  const m = moveSection(lisbon, sectionRange(lisbon, lineOf(lisbon, "### Packing")).lines, 3, "# Trip\nnotes", 2, 2);
  assert.match(m.dst, /^# Trip\nnotes\n\n## Packing\n- \[ \] Rain jacket/);
  assert.equal(m.src.includes("Packing"), false);
});

test("section slots: a note's end lies before its closing labels", () => {
  const body = "## A\ntext\n\n#travel";
  assert.equal(sectionSlots(body).at(-1).line, 2);
  assert.equal(moveSection("## B\nb", [0, 2], 2, body, 2, 2).dst, "## A\ntext\n\n## B\nb\n\n#travel");
});

test("section slots: each heading's slot names the section it starts", () => {
  assert.deepEqual(sectionSlots("Intro\n## A\n## B").map(s => s.anchor), [{ section: 1 }, { section: 2 }, { end: true }]);
});

test("move parts: several items of two notes land together on one level", () => {
  const bodies = { a: "- a1\n  - a1x\n- a2\n- a3", b: "## B\n- b1\n- b2" };
  const out = moveParts(bodies, [{ noteId: "a", lines: [0, 2], from: 0 }, { noteId: "a", lines: [3, 4], from: 0 }], "b", 2, 0, "item");
  assert.equal(out.a, "- a2");
  assert.equal(out.b, "## B\n- b1\n- a1\n  - a1x\n- a3\n- b2");
});

test("move parts: within one note, the slot counted with the parts still in place; a note left empty is null", () => {
  const bodies = { a: "- x\n- y\n- z", b: "- only" };
  const out = moveParts(bodies, [{ noteId: "b", lines: [0, 1], from: 0 }, { noteId: "a", lines: [0, 1], from: 0 }], "a", 3, 2, "item");
  assert.equal(out.b, null);
  assert.equal(out.a, "- y\n- z\n  - only\n  - x");
});

test("move parts: sections take the dropped level, their subsections shift along", () => {
  const bodies = { a: "# T\n## S1\ntext\n### S1a\n## S2\nmore", b: "# U\n## V\nv" };
  const out = moveParts(bodies, [{ noteId: "a", lines: [1, 4], from: 2 }, { noteId: "a", lines: [4, 6], from: 2 }], "b", 3, 3, "section");
  assert.equal(out.a, "# T");
  assert.equal(out.b, "# U\n## V\nv\n\n### S1\ntext\n#### S1a\n### S2\nmore");
});

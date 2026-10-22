// Unit tests for list items as selectable and movable parts (app/js/core/list-items.js) and their place in
// the selection (core/selection.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNotesFile } from "../app/js/core/notes-file.js";
import { tableOfContents } from "../app/js/core/query.js";
import { listItems, itemKey, parseItemKey, itemBlocks, moveItems, canMoveItems } from "../app/js/core/list-items.js";
import { selectedParts, partText, partPreview, withoutParts, toggleItem, shiftItemKeys, toggleNote } from "../app/js/core/selection.js";
import { moveInto } from "../app/js/core/move.js";

const notes = parseNotesFile(readFileSync(new URL("../app/sample/notes.md", import.meta.url), "utf8")).notes;
const lisbon = notes.find(n => n.body.includes("Book flights"));
const lines = body => body.split("\n");
const lineOf = (body, text) => lines(body).findIndex(l => l.includes(text));

test("list items: start, end with sub-items, outside code, no rules", () => {
  const body = "Intro\n- a\n  more of a\n  - a1\n- b\n\n* * *\n```\n- code\n```\n1. one";
  assert.deepEqual(listItems(body).map(i => [i.line, i.end, i.indent]), [[1, 4, 0], [3, 4, 2], [4, 5, 0], [10, 11, 0]]);
});

test("list items: one per rendered <li> in the sample's Lisbon note", () => {
  const items = listItems(lisbon.body);
  const sub = items.find(i => i.line === lineOf(lisbon.body, "Seats 14A"));
  assert.equal(sub.indent, 2);
  const book = items.find(i => i.line === lineOf(lisbon.body, "Book flights"));
  assert.equal(book.end, sub.end);
});

test("item keys: the note's address may hold an @ itself", () => {
  assert.deepEqual(parseItemKey(itemKey("n1@abc", 4)), { noteId: "n1@abc", line: 4 });
  assert.equal(parseItemKey("n1#2"), null);
  assert.equal(parseItemKey("n1@abc#2"), null);
});

test("move: an item swaps with its sibling, taking its sub-items along", () => {
  const body = "- a\n  - a1\n- b\n- c";
  const down = moveItems(body, [0], 1);
  assert.equal(down.body, "- b\n- a\n  - a1\n- c");
  assert.equal(down.shift, 1);
  const up = moveItems(body, [2], -1);
  assert.equal(up.body, "- b\n- a\n  - a1\n- c");
  assert.equal(up.shift, -2);
  assert.equal(canMoveItems(body, [0], -1), false);   // first in its list
  assert.equal(canMoveItems(body, [1], 1), false);    // a1 has no sibling
});

test("move: consecutive siblings move as one block; others don't", () => {
  const body = "- a\n- b\n- c\n- d";
  assert.equal(moveItems(body, [1, 2], -1).body, "- b\n- c\n- a\n- d");
  assert.equal(moveItems(body, [1, 2], 1).body, "- a\n- d\n- b\n- c");
  assert.equal(moveItems(body, [0, 2], 1), null);
  assert.equal(itemBlocks(body, [0, 2]).length, 2);
});

test("move: blank lines between items stay where they were; lists apart don't mix", () => {
  assert.equal(moveItems("- a\n\n- b", [0], 1).body, "- b\n\n- a");
  assert.equal(canMoveItems("- a\n\ntext\n\n- b", [0], 1), false);
  assert.equal(canMoveItems("## A\n- a\n## B\n- b", [1], 1), false);
});

test("selection: an item is a part of its own, in contents order with the sections", () => {
  const entries = tableOfContents([lisbon]).entries;
  const bodies = { [lisbon.id]: lisbon.body };
  const line = lineOf(lisbon.body, "Ask Tom");
  let sel = toggleItem(new Set(), lisbon.id, line);
  const [part] = selectedParts(entries, sel, bodies);
  assert.equal(part.item, true);
  assert.equal(partText(lisbon.body, part), lines(lisbon.body)[line]);
  assert.equal(partPreview(lisbon.body, part).text, "Ask Tom for the restaurant list");
  assert.equal(withoutParts(lisbon.body, [part]).includes("Ask Tom"), false);
  // Inside a selected (whole) note, the item isn't a part of its own.
  sel = toggleNote(entries, sel, lisbon.id);
  assert.equal(selectedParts(entries, sel, bodies).length, 1);
  assert.equal(selectedParts(entries, sel, bodies)[0].whole, true);
});

test("selection: a sub-item leaves its indent behind; keys follow a move", () => {
  const body = "- a\n  - a1\n    - a11\n- b";
  const entries = tableOfContents([{ id: "x", body }]).entries;
  const [part] = selectedParts(entries, toggleItem(new Set(), "x", 1), { x: body });
  assert.equal(partText(body, part), "- a1\n  - a11");
  assert.deepEqual([...shiftItemKeys(new Set(["x@1", "x#0", "y@1"]), "x", 2)].sort(), ["x#0", "x@3", "y@1"]);
});

test("Move to: a selected task goes into another note's task list", () => {
  const target = notes.find(n => n.body.includes("Dishwasher tablets"));
  const parts = selectedParts(tableOfContents([lisbon, target]).entries, toggleItem(new Set(), lisbon.id, lineOf(lisbon.body, "Ask Tom")), { [lisbon.id]: lisbon.body, [target.id]: target.body });
  const m = moveInto({ [lisbon.id]: lisbon, [target.id]: target }, parts, target.id, 0, { asTask: true });
  assert.match(m.body, /Dishwasher tablets\n- \[ \] Ask Tom/);
  assert.equal(m.changes[0].body.includes("Ask Tom"), false);
});

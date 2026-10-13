// Unit tests for the multi-select core (app/js/core/selection.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createNote } from "../app/js/core/notes-file.js";
import { selectedInOrder, rangeIds, copyText, mergedNote, previewLine } from "../app/js/core/selection.js";

const n = (id, body, extra) => Object.assign(createNote(body, "2026-10-05T09:00", id), extra);

test("selection: selected notes follow the view order, not the selection order", () => {
  const notes = [n("a", "A"), n("b", "B"), n("c", "C")];
  assert.deepEqual(selectedInOrder(notes, ["c", "a"]).map(x => x.id), ["a", "c"]);
});

test("selection: Shift range works in both directions and without an anchor", () => {
  const order = ["a", "b", "c", "d"];
  assert.deepEqual(rangeIds(order, "b", "d"), ["b", "c", "d"]);
  assert.deepEqual(rangeIds(order, "d", "b"), ["b", "c", "d"]);
  assert.deepEqual(rangeIds(order, "x", "c"), ["c"]);
  assert.deepEqual(rangeIds(order, "a", "x"), []);
});

test("selection: copy joins the bodies with a blank line", () => {
  assert.equal(copyText([n("a", "## A\ntext\n"), n("b", "- [ ] task")]), "## A\ntext\n\n- [ ] task");
});

test("selection: merge keeps the earliest created and due date", () => {
  const m = mergedNote([
    n("a", "## A", { created: "2026-10-08T10:00", due: "2026-10-20" }),
    n("b", "B.", { created: "2026-10-02T08:00", due: null }),
    n("c", "C.", { created: "2026-10-04T08:00", due: "2026-10-15" }),
  ]);
  assert.deepEqual(m, { body: "## A\n\nB.\n\nC.", created: "2026-10-02T08:00", due: "2026-10-15" });
  assert.equal(mergedNote([n("a", "A"), n("b", "B")]).due, null);
});

test("selection: preview line is the first heading, else the first sentence", () => {
  assert.deepEqual(previewLine(n("a", "Intro.\n## Head")), { text: "Head", fromHeading: true });
  assert.deepEqual(previewLine(n("b", "Call Anna. Then book.")), { text: "Call Anna.", fromHeading: false });
});

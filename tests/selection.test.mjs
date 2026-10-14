// Unit tests for the multi-select core (app/js/core/selection.js) and the
// sections it works on (markdown.js, query.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createNote, parseNotesFile } from "../app/js/core/notes-file.js";
import { sections } from "../app/js/core/markdown.js";
import { tableOfContents } from "../app/js/core/query.js";
import {
  rangeIds, subtree, toggleEntry, selectEntryRange, noteState, toggleNote, selectNotes, selectedParts,
  partText, partPreview, withoutParts, copyText, hasHeadings, canShiftHeadings, shiftHeadings, alignParts, mergeParts,
} from "../app/js/core/selection.js";

const n = (id, body, extra) => Object.assign(createNote(body, "2026-10-05T09:00", id), extra);
const byId = notes => Object.fromEntries(notes.map(x => [x.id, x]));
// The open sample notes in file order (= last edited, the default view order).
const sample = parseNotesFile(readFileSync(new URL("../app/sample/notes.md", import.meta.url), "utf8")).notes.filter(x => x.status === "open");
const keyOf = (entries, text) => entries.findIndex(e => e.text.startsWith(text));

test("sections: untitled lead, top-level headings only, line ranges", () => {
  const body = "Intro.\n\n## A\n```\n## not a heading\n```\n> ## quoted\n### B\ntext";
  assert.deepEqual(sections(body).map(s => [s.start, s.end, s.depth, s.text]),
    [[0, 2, null, "Intro."], [2, 7, 2, "A"], [7, 9, 3, "B"]]);
  assert.deepEqual(sections("## A\ntext").map(s => s.depth), [2]);
  assert.deepEqual(sections("Just text. More.").map(s => [s.start, s.end, s.text]), [[0, 1, "Just text."]]);
});

test("contents: an untitled note hangs one level below the last heading above it", () => {
  const toc = tableOfContents(sample);
  const at = text => toc.entries[keyOf(toc.entries, text)];
  assert.equal(at("Weekly groceries").level, 1);
  assert.equal(at("Remind Lea").level, 2);
  assert.equal(at("Remind Lea").fromHeading, false);
  assert.equal(at("Sintra").level, 3);
  assert.equal(at("Idea for the team meeting").level, 2);
  assert.equal(tableOfContents([n("a", "Plain. More.")]).entries[0].level, 1);
});

test("selection: an entry takes everything below it, across notes, and can be taken out again", () => {
  const { entries } = tableOfContents(sample);
  let sel = toggleEntry(entries, new Set(), keyOf(entries, "Weekly groceries"));
  assert.deepEqual([...sel].map(k => entries.find(e => e.key === k).text.slice(0, 10)), ["Weekly gro", "Remind Lea"]);
  sel = toggleEntry(entries, sel, keyOf(entries, "Remind Lea"));
  assert.equal(sel.size, 1);
  sel = toggleEntry(entries, new Set(), keyOf(entries, "Things to see"));
  assert.equal(sel.size, 3); // with Lisbon and Sintra
  assert.deepEqual(subtree(entries, keyOf(entries, "Packing")), []);
});

test("selection: Shift range in the contents includes what is below its end", () => {
  const { entries } = tableOfContents(sample);
  const sel = selectEntryRange(entries, new Set(), keyOf(entries, "Things to see"), keyOf(entries, "Before we go"));
  assert.equal(sel.size, 4); // Before we go, Things to see, Lisbon, Sintra
});

test("selection: a card toggles its whole note; ranges of notes", () => {
  const { entries } = tableOfContents(sample);
  let sel = toggleEntry(entries, new Set(), keyOf(entries, "Packing"));
  assert.equal(noteState(entries, sel, "s03"), "some");
  sel = toggleNote(entries, sel, "s03");
  assert.equal(noteState(entries, sel, "s03"), "all");
  sel = toggleNote(entries, sel, "s03");
  assert.equal(noteState(entries, sel, "s03"), "none");
  assert.deepEqual(rangeIds(["a", "b", "c", "d"], "d", "b"), ["b", "c", "d"]);
  assert.deepEqual(rangeIds(["a", "b"], "x", "b"), ["b"]);
  assert.equal(selectNotes(entries, new Set(), ["s01", "s02"]).size, 2);
});

test("selection: parts are runs of adjacent sections of one note", () => {
  const { entries } = tableOfContents(sample);
  let sel = toggleEntry(entries, new Set(), keyOf(entries, "Weekly groceries"));
  sel = toggleEntry(entries, sel, keyOf(entries, "Things to see"));
  sel = toggleEntry(entries, sel, keyOf(entries, "Packing"));
  assert.deepEqual(selectedParts(entries, sel), [
    { noteId: "s01", from: 0, to: 1, whole: true },
    { noteId: "s02", from: 0, to: 1, whole: true },
    { noteId: "s03", from: 2, to: 6, whole: false },
  ]);
});

test("parts: text, preview, what is left, copy", () => {
  const body = "Intro.\n## A\na\n### A1\nb\n## B\nc";
  assert.equal(partText(body, { from: 1, to: 3 }), "## A\na\n### A1\nb");
  assert.deepEqual(partPreview(body, { from: 2, to: 3 }), { text: "A1", fromHeading: true });
  assert.deepEqual(partPreview(body, { whole: true }), { text: "A", fromHeading: true });
  assert.equal(withoutParts(body, [{ from: 1, to: 3 }]), "Intro.\n## B\nc");
  assert.equal(withoutParts(body, [{ from: 0, to: 4 }]), null);
  assert.equal(copyText(["## A", "b"]), "## A\n\nb");
});

test("headings: shift up and down within 1–6, code lines untouched", () => {
  const body = "## A\n```\n## code\n```\n### B";
  const all = [{ whole: true }];
  assert.equal(shiftHeadings(body, all, 1), "### A\n```\n## code\n```\n#### B");
  assert.equal(shiftHeadings(body, all, -1), "# A\n```\n## code\n```\n## B");
  assert.equal(canShiftHeadings("# A\n## B", all, -1), false);
  assert.equal(canShiftHeadings("###### A", all, 1), false);
  assert.equal(canShiftHeadings("No heading.", all, 1), false);
  assert.equal(hasHeadings("No heading.\n```\n# code\n```", all), false);
  assert.equal(hasHeadings("# A", all), true);
  assert.equal(shiftHeadings("## A\n## B\n### B1", [{ from: 1, to: 3 }], 1), "## A\n### B\n#### B1");
});

test("align: each part's top heading becomes ## (or # when one part uses it)", () => {
  assert.deepEqual(alignParts(["## A\n### A1", "#### S\ntext", "Plain."]), ["## A\n### A1", "## S\ntext", "Plain."]);
  assert.deepEqual(alignParts(["# A", "### B"]), ["# A", "# B"]);
  assert.deepEqual(alignParts(["#### S"]), ["## S"]);
});

test("merge: parts in the given order, earliest created and due, what stays behind", () => {
  const a = n("a", "## A\nx\n## B\ny", { created: "2026-10-08T10:00", due: "2026-10-20" });
  const b = n("b", "Plain.", { created: "2026-10-02T08:00", due: null });
  const c = n("c", "## C\n#### C1\nz", { created: "2026-10-04T08:00", due: "2026-10-15" });
  const m = mergeParts(byId([a, b, c]), [{ noteId: "c", from: 1, to: 2 }, { noteId: "a", from: 0, to: 1 }, { noteId: "b", from: 0, to: 1, whole: true }]);
  assert.equal(m.body, "## C1\nz\n\n## A\nx\n\nPlain.");
  assert.equal(m.created, "2026-10-02T08:00");
  assert.equal(m.due, "2026-10-15");
  assert.deepEqual(m.changes, [{ id: "c", body: "## C" }, { id: "a", body: "## B\ny" }, { id: "b", body: null }]);
});

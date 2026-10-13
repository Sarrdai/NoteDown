// Unit tests for the framework-free core (app/js/core). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNotesFile, serializeNotesFile, createNote } from "../app/js/core/notes-file.js";
import { headings, noteTitle, firstSentence, toggleTask } from "../app/js/core/markdown.js";
import { viewNotes, sortNotes, tableOfContents, closedOn } from "../app/js/core/query.js";

const sample = readFileSync(new URL("../app/sample/notes.md", import.meta.url), "utf8");

test("file format: sample parses and round-trips unchanged", () => {
  const file = parseNotesFile(sample);
  assert.ok(file.notes.length >= 10);
  assert.ok(file.notes.some(n => n.status === "closed" && n.closed));
  assert.equal(serializeNotesFile(parseNotesFile(serializeNotesFile(file))), serializeNotesFile(file));
});

test("file format: metadata and body survive, preamble is kept", () => {
  const text = "# My notes\n\n<!-- note id=a status=closed created=2026-10-01T09:00 modified=2026-10-02T10:00 due=2026-10-05 closed=2026-10-03T11:00 -->\n## A\ntext\n";
  const { preamble, notes } = parseNotesFile(text);
  assert.equal(preamble, "# My notes");
  assert.deepEqual(notes[0], { id: "a", status: "closed", created: "2026-10-01T09:00", modified: "2026-10-02T10:00", due: "2026-10-05", closed: "2026-10-03T11:00", body: "## A\ntext" });
  assert.equal(serializeNotesFile({ preamble, notes }), text);
});

test("markdown: headings, title and first sentence", () => {
  assert.deepEqual(headings("## One\ntext\n### Two `x`\n```\n## not a heading\n```"), [{ depth: 2, text: "One" }, { depth: 3, text: "Two x" }]);
  assert.deepEqual(noteTitle("Call **Anna** about the trip. Then book."), { text: "Call Anna about the trip.", fromHeading: false });
  assert.equal(firstSentence("a".repeat(100), 10), "aaaaaaaaa…");
});

test("markdown: toggleTask flips the n-th checkbox outside code fences", () => {
  const body = "- [ ] one\n```\n- [ ] code\n```\n  - [x] two";
  assert.equal(toggleTask(body, 0), "- [x] one\n```\n- [ ] code\n```\n  - [x] two");
  assert.equal(toggleTask(body, 1), "- [ ] one\n```\n- [ ] code\n```\n  - [ ] two");
});

const n = (id, extra) => Object.assign(createNote("## " + id, "2026-10-01T09:00", id), extra);

test("query: view filter, search and sort with missing values last", () => {
  const notes = [n("b", { due: "2026-10-09" }), n("a", { modified: "2026-10-05T08:00" }), n("c", { due: "2026-10-02", status: "closed" })];
  assert.deepEqual(viewNotes(notes, { status: "open", sort: { key: "modified", dir: "desc" } }).map(x => x.id), ["a", "b"]);
  assert.deepEqual(viewNotes(notes, { status: "open", search: "B", sort: { key: "title", dir: "asc" } }).map(x => x.id), ["b"]);
  assert.deepEqual(sortNotes(notes, { key: "due", dir: "asc" }).map(x => x.id), ["c", "b", "a"]);
  assert.deepEqual(sortNotes(notes, { key: "due", dir: "desc" }).map(x => x.id), ["b", "c", "a"]);
  assert.deepEqual(sortNotes(notes, { key: "title", dir: "desc" }).map(x => x.id), ["c", "b", "a"]);
});

test("query: table of contents counts levels from the highest heading present", () => {
  const notes = [createNote("## A\n### A1\n#### A1a", "t", "1"), createNote("Plain note. More.", "t", "2")];
  const toc = tableOfContents(notes);
  assert.equal(toc.maxLevel, 3);
  assert.deepEqual(toc.entries.map(e => [e.noteId, e.level, e.text]), [["1", 1, "A"], ["1", 2, "A1"], ["1", 3, "A1a"], ["2", 1, "Plain note."]]);
});

test("query: closedOn counts notes closed on that day", () => {
  const notes = [n("a", { status: "closed", closed: "2026-10-13T08:00" }), n("b", { status: "closed", closed: "2026-10-12T08:00" }), n("c")];
  assert.equal(closedOn(notes, "2026-10-13"), 1);
});

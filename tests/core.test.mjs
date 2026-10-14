// Unit tests for the framework-free core (app/js/core). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNotesFile, serializeNotesFile, createNote } from "../app/js/core/notes-file.js";
import { headings, noteTitle, firstSentence, toggleTask } from "../app/js/core/markdown.js";
import { viewNotes, sortNotes, customSplit, rearrange, tableOfContents, closedOn, protectedFirst, deleteGroups } from "../app/js/core/query.js";

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
  assert.equal(toc.maxLevel, 4); // the untitled note hangs below A1a
  assert.deepEqual(toc.entries.map(e => [e.noteId, e.level, e.text]), [["1", 1, "A"], ["1", 2, "A1"], ["1", 3, "A1a"], ["2", 4, "Plain note."]]);
  assert.deepEqual(tableOfContents([notes[1]]).entries.map(e => [e.key, e.level, e.fromHeading]), [["2#0", 1, false]]);
});

test("query: closedOn counts notes closed on that day", () => {
  const notes = [n("a", { status: "closed", closed: "2026-10-13T08:00" }), n("b", { status: "closed", closed: "2026-10-12T08:00" }), n("c")];
  assert.equal(closedOn(notes, "2026-10-13"), 1);
});

test("time: timestamps are written in UTC and shown in the device's time zone", async () => {
  const { timestamp, localTime } = await import("../app/js/core/notes-file.js");
  const tz = process.env.TZ;
  process.env.TZ = "Europe/Berlin";
  try {
    assert.equal(timestamp(new Date(Date.UTC(2026, 9, 13, 8, 5))), "2026-10-13T08:05Z");
    assert.equal(localTime("2026-10-13T08:05Z"), "2026-10-13T10:05");
    assert.equal(localTime("2026-10-13T08:05"), "2026-10-13T08:05"); // older local timestamp
    const closed = n("a", { status: "closed", closed: "2026-10-12T23:30Z" });
    assert.equal(closedOn([closed], "2026-10-13"), 1);
  } finally {
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
});

test("query: protected first keeps the order inside both groups", () => {
  const notes = ["a", "b", "c", "d"].map(id => n(id));
  const marked = new Set(["c", "a"]);
  assert.deepEqual(protectedFirst(notes, id => marked.has(id)).map(x => x.id), ["a", "c", "b", "d"]);
  assert.deepEqual(protectedFirst(notes, () => false).map(x => x.id), ["a", "b", "c", "d"]);
});

test("query: delete groups keep protected notes and split shared ones", () => {
  const notes = ["a", "b", "c", "d"].map(id => n(id));
  const g = deleteGroups(notes, { isProtected: id => id === "b" || id === "d", isShared: id => id === "c" || id === "d" });
  assert.deepEqual([g.kept, g.private, g.shared].map(xs => xs.map(x => x.id)), [["b", "d"], ["a"], ["c"]]);
});

test("custom order: listed notes in list order, the rest by last edited, newest first", () => {
  const notes = parseNotesFile(sample).notes.filter(n => n.status === "open");
  const [a, b, c] = notes.map(n => n.id);
  const { sorted, unsorted } = customSplit(notes, [c, "gone", a]);
  assert.deepEqual(sorted.map(n => n.id), [c, a]);
  assert.equal(unsorted.length, notes.length - 2);
  assert.ok(unsorted.every((n, i) => !i || unsorted[i - 1].modified >= n.modified));
  const view = viewNotes(notes, { status: "open", sort: { key: "custom", dir: "asc" }, order: [b] });
  assert.equal(view[0].id, b);
});

test("rearrange: shown notes refill their old places, new ones go last, hidden ones stay", () => {
  assert.deepEqual(rearrange(["a", "x", "b", "y"], ["a", "b", "c"], ["c", "a", "b"]), ["c", "x", "a", "y", "b"]);
  assert.deepEqual(rearrange(["a", "x", "b"], ["a", "b"], ["b"]), ["b", "x"]);
  assert.deepEqual(rearrange([], ["a"], ["a"]), ["a"]);
});

test("file format: an order marker round-trips; without ids it is an empty order", () => {
  const file = parseNotesFile(sample);
  const text = serializeNotesFile({ ...file, order: { ids: ["s02", "s01"], modified: "2026-10-14T09:00Z" } });
  assert.match(text, /<!-- order modified=2026-10-14T09:00Z ids=s02,s01 -->\n$/);
  assert.deepEqual(parseNotesFile(text).order, { ids: ["s02", "s01"], modified: "2026-10-14T09:00Z" });
  assert.deepEqual(parseNotesFile(serializeNotesFile({ notes: [], order: { ids: [], modified: "2026-10-14T09:00Z" } })).order, { ids: [], modified: "2026-10-14T09:00Z" });
  assert.equal(parseNotesFile(sample).order, null);
});

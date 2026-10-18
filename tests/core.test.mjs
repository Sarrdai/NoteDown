// Unit tests for the framework-free core (app/js/core). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNotesFile, serializeNotesFile, createNote } from "../app/js/core/notes-file.js";
import { headings, noteTitle, firstSentence, toggleTask, tasks, setTaskState, renderMarkdown } from "../app/js/core/markdown.js";
import { viewNotes, matchRanges, sortNotes, customSplit, rearrange, isSectionId, sectionId, sectionTitle, orderSections, arrangeRows, tableOfContents, closedOn, permanentFirst, inViewOf, expiredTrash, TRASH_DAYS } from "../app/js/core/query.js";

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

test("query: permanent first keeps the order inside both groups", () => {
  const notes = ["a", "b", "c", "d"].map(id => n(id, { status: id === "c" || id === "a" ? "permanent" : "open" }));
  assert.deepEqual(permanentFirst(notes).map(x => x.id), ["a", "c", "b", "d"]);
  assert.deepEqual(permanentFirst(notes.map(x => ({ ...x, status: "open" }))).map(x => x.id), ["a", "b", "c", "d"]);
});

test("query: the main view shows open and permanent notes, the trash every deleted note", () => {
  const notes = [n("o"), n("p", { status: "permanent" }), n("c", { status: "closed" }), n("d", { deleted: "2026-10-13T08:00Z" }), n("dc", { status: "closed", deleted: "2026-10-13T08:00Z" })];
  const ids = view => notes.filter(x => inViewOf(x, view)).map(x => x.id);
  assert.deepEqual([ids("open"), ids("closed"), ids("trash")], [["o", "p"], ["c"], ["d", "dc"]]);
  assert.equal(closedOn([notes[4]], "2026-10-13"), 0, "a trashed note doesn't count as closed today");
});

test("query: trashed notes expire after TRASH_DAYS", () => {
  const now = Date.parse("2026-10-31T12:00Z");
  const notes = [n("old", { deleted: "2026-10-01T11:00Z" }), n("young", { deleted: "2026-10-01T13:00Z" }), n("live")];
  assert.equal(TRASH_DAYS, 30);
  assert.deepEqual(expiredTrash(notes, now).map(x => x.id), ["old"]);
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

test("custom order sections: an id entry with the encoded title, notes belong to the one above them", () => {
  const id = sectionId(" Home, garden & more ");
  assert.equal(id, "~Home%2C%20garden%20%26%20more");
  assert.ok(isSectionId(id) && !isSectionId("s01"));
  assert.equal(sectionTitle(id), "Home, garden & more");
  assert.equal(sectionTitle("~100%"), "100%");   // not decodable: kept as written
  const of = orderSections(["a", "~One", "b", "c", "~Two", "~Three", "d"]);
  assert.deepEqual([...of], [["b", "~One"], ["c", "~One"], ["d", "~Three"]]);
});

test("custom order sections: the dialog lists every section, sections survive rearranging and the file", () => {
  const notes = ["a", "b", "c"].map(id => ({ id }));
  assert.deepEqual(arrangeRows(notes, ["~One", "a", "x", "~Two", "c"]), [{ section: "~One" }, notes[0], { section: "~Two" }, notes[2]]);
  // x is hidden by a search: it keeps its place; the sections move like shown notes.
  assert.deepEqual(rearrange(["~One", "a", "x", "~Two", "c"], ["a", "c"], ["~Two", "c", "~One", "a"]), ["~Two", "c", "x", "~One", "a"]);
  // A removed section's place is refilled; a new one and two of the same title are kept.
  assert.deepEqual(rearrange(["~One", "a"], ["a"], ["a", "~New", "~New"]), ["a", "~New", "~New"]);
  const file = parseNotesFile(sample);
  const ids = [sectionId("Home & garden"), "s01"];
  assert.deepEqual(parseNotesFile(serializeNotesFile({ ...file, order: { ids, modified: "2026-10-14T09:00Z" } })).order.ids, ids);
});

test("file format: an order marker round-trips; without ids it is an empty order", () => {
  const file = parseNotesFile(sample);
  const text = serializeNotesFile({ ...file, order: { ids: ["s02", "s01"], modified: "2026-10-14T09:00Z" } });
  assert.match(text, /<!-- order modified=2026-10-14T09:00Z ids=s02,s01 -->\n$/);
  assert.deepEqual(parseNotesFile(text).order, { ids: ["s02", "s01"], modified: "2026-10-14T09:00Z" });
  assert.deepEqual(parseNotesFile(serializeNotesFile({ notes: [], order: { ids: [], modified: "2026-10-14T09:00Z" } })).order, { ids: [], modified: "2026-10-14T09:00Z" });
  assert.deepEqual(parseNotesFile(sample).order.ids.filter(isSectionId), ["~Home", "~Travel", "~Paperwork"]);   // the sample shows sections
});

test("file format: contacts round-trip after the devices and before the order, text after a marker is dropped", () => {
  const contacts = [
    { id: "TGVhSWRlbnRpdHkxMjM0NQ", name: "Lea Müller", color: 2 },
    { id: "VG9tSWRlbnRpdHkxMjM0NTY", name: "Tom", color: 4, pending: "2026-10-14T09:00Z" },
  ];
  const file = parseNotesFile(sample);
  const text = serializeNotesFile({
    ...file, devices: [{ id: "d1", name: "Phone" }], contacts, order: { ids: ["s02"], modified: "2026-10-14T09:00Z" },
  });
  assert.match(text, /<!-- device id=d1 name=Phone -->\n\n<!-- contact id=TGVhSWRlbnRpdHkxMjM0NQ name=Lea%20M%C3%BCller color=2 -->\n\n<!-- contact id=VG9tSWRlbnRpdHkxMjM0NTY name=Tom color=4 pending=2026-10-14T09:00Z -->\n\n<!-- order /);
  const parsed = parseNotesFile(text);
  assert.deepEqual(parsed.contacts, contacts);
  assert.equal(parsed.notes.length, file.notes.length);
  assert.deepEqual(parsed.devices, [{ id: "d1", name: "Phone" }]);
  // Text below a contact marker is not part of any note.
  const extra = parseNotesFile("<!-- contact id=a name=A color=1 -->\nstray text\n");
  assert.deepEqual(extra.contacts, [{ id: "a", name: "A", color: 1 }]);
  assert.deepEqual(extra.notes, []);
  // A bad color falls back to slot 1; a marker without a name is ignored.
  assert.deepEqual(parseNotesFile("<!-- contact id=a name=A color=9 -->\n\n<!-- contact id=b color=2 -->").contacts, [{ id: "a", name: "A", color: 1 }]);
  assert.deepEqual(parseNotesFile("").contacts, []);
});

test("file format: a contact's home server round-trips percent-encoded; absent means the default server", () => {
  const contacts = [
    { id: "a", name: "A", color: 2, server: "https://notes.example.org/api" },
    { id: "b", name: "B", color: 3, server: "http://127.0.0.1:8765", pending: "2026-10-14T09:00Z" },
    { id: "c", name: "C", color: 4 },
  ];
  const text = serializeNotesFile({ ...parseNotesFile(""), contacts });
  assert.match(text, /<!-- contact id=a name=A color=2 server=https%3A%2F%2Fnotes\.example\.org%2Fapi -->/);
  assert.match(text, /color=3 server=http%3A%2F%2F127\.0\.0\.1%3A8765 pending=2026-10-14T09:00Z -->/);
  assert.deepEqual(parseNotesFile(text).contacts, contacts);
  assert.equal("server" in parseNotesFile("<!-- contact id=c name=C color=4 -->").contacts[0], false);
});

test("file format: a contact's verified time round-trips; absent means not verified", () => {
  const contacts = [
    { id: "a", name: "A", color: 2, verified: "2026-10-14T09:00Z" },
    { id: "b", name: "B", color: 3, pending: "2026-10-14T09:00Z", verified: "2026-10-14T09:00Z" },
    { id: "c", name: "C", color: 4 },
  ];
  const text = serializeNotesFile({ ...parseNotesFile(""), contacts });
  assert.match(text, /<!-- contact id=a name=A color=2 verified=2026-10-14T09:00Z -->/);
  assert.match(text, /color=3 pending=2026-10-14T09:00Z verified=2026-10-14T09:00Z -->/);
  assert.deepEqual(parseNotesFile(text).contacts, contacts);
  assert.equal("verified" in parseNotesFile("<!-- contact id=c name=C color=4 -->").contacts[0], false);
});

test("markdown: script links are disarmed, also with tabs or newlines in the scheme", async () => {
  const { renderMarkdown } = await import("../app/js/core/markdown.js");
  for (const src of ["[a](javascript:alert(1))", "[a](<java\tscript:alert(1)>)", "[a](<java\nscript:alert(1)>)", "[a](< javascript:alert(1)>)"]) {
    assert.doesNotMatch(renderMarkdown(src), /href="(?!#")/, src);
  }
  assert.match(renderMarkdown("[a](https://example.com)"), /href="https:\/\/example.com"/);
});

test("query: search hits are found case-insensitively, also with regex characters", () => {
  assert.deepEqual(matchRanges("Lisbon trip, lisbon tram", " LISBON "), [[0, 6], [13, 19]]);
  assert.deepEqual(matchRanges("aaaa", "aa"), [[0, 2], [2, 4]]);
  assert.deepEqual(matchRanges("costs (1+2)?", "(1+2)?"), [[6, 12]]);
  assert.deepEqual(matchRanges("anything", "  "), []);
});

test("renderMarkdown: a table sits in a box that scrolls sideways (backlog #44)", () => {
  const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
  assert.match(html, /^<div class="md-table"><table>[\s\S]*<\/table><\/div>\s*$/);
  assert.doesNotMatch(renderMarkdown("<table>x</table>"), /md-table/, "raw HTML stays text");
});

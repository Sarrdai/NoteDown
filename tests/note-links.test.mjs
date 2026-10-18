// Unit tests for links between notes and private copies (app/js/core/note-links.js) and the line diff
// (app/js/core/line-diff.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { noteLinkId, noteLink, linkTrigger, linkCandidates, privateCopy, copyState } from "../app/js/core/note-links.js";
import { lineDiff, diffCounts, foldSame, sideBySide } from "../app/js/core/line-diff.js";
import { parseNotesFile, serializeNotesFile } from "../app/js/core/notes-file.js";
import { mergeNotesFiles } from "../app/js/core/merge.js";

const text = readFileSync(new URL("../app/sample/notes.md", import.meta.url), "utf8");
const { notes } = parseNotesFile(text);
const byId = id => notes.find(n => n.id === id);

test("note links: the address names the note by id", () => {
  assert.equal(noteLinkId("note:s03"), "s03");
  assert.equal(noteLinkId(" note:n1a_b-2 "), "n1a_b-2");
  assert.equal(noteLinkId("https://example.com"), null);
  assert.equal(noteLinkId("note:"), null);
  assert.equal(noteLinkId("note:a b"), null);
  assert.equal(noteLink("s03", "Trip to Lisbon"), "[Trip to Lisbon](note:s03)");
  assert.equal(noteLink("x", "A [draft]\n plan"), "[A \\[draft\\] plan](note:x)");
  assert.equal(noteLink("x", ""), "[Untitled](note:x)");
  assert.match(byId("s02").body, /\[trip\]\(note:s03\)/);
});

test("note links: [[ before the caret opens the picker with what follows it", () => {
  assert.deepEqual(linkTrigger("See [[Tri"), { from: 4, query: "Tri" });
  assert.deepEqual(linkTrigger("[["), { from: 0, query: "" });
  assert.equal(linkTrigger("See [[Trip]] now"), null);
  assert.equal(linkTrigger("one [ two"), null);
});

test("note links: a private note may link to any note, a shared one only within its circle", () => {
  const circles = { s01: "lea", s09: "lea", s21: "", s03: "", s16: "" };
  const circle = id => circles[id] ?? "";
  const pool = ["s01", "s09", "s03", "s16", "s21"].map(byId);
  const fromPrivate = linkCandidates(pool, { from: "s21", circle }).map(c => c.id);
  assert.deepEqual([...fromPrivate].sort(), ["s01", "s03", "s09", "s16"]);
  assert.deepEqual(linkCandidates(pool, { from: "s09", circle }).map(c => c.id), ["s01"]);
  // A title starting with the query first, open before closed.
  const hits = linkCandidates(pool, { from: "s21", circle, query: "e" });
  assert.ok(hits.every(c => c.title.toLowerCase().includes("e")));
  assert.equal(linkCandidates(pool, { from: "s21", circle, query: "move" })[0].id, "s16");
  assert.equal(linkCandidates(pool, { from: "s21", circle, query: "move" })[0].closed, true);
  assert.equal(linkCandidates(pool, { from: "s21", circle, query: "zzz" }).length, 0);
  assert.equal(linkCandidates(pool, { from: "s21", circle, limit: 2 }).length, 2);
});

test("private copy: same text and look, linked back to the original, and in the file format", () => {
  const o = byId("s09");
  const c = privateCopy(o, "2026-10-14T09:00Z", "c1");
  assert.equal(c.body, o.body);
  assert.equal(c.status, "open");
  assert.deepEqual([c.due, c.color, c.decor, c.copyof, c.copied], [o.due, o.color, o.decor, "s09", o.modified]);
  assert.equal(copyState(c, o), "same");
  assert.equal(copyState({ ...c, body: c.body + "\nmine" }, o), "differs");
  assert.equal(copyState(c, { ...o, modified: "2026-10-15T10:00Z" }), "changed");
  assert.equal(copyState(c, null), "gone");
  const s21 = byId("s21");
  assert.deepEqual([s21.copyof, s21.copied], ["s09", "2026-10-06T17:30Z"]);
  assert.equal(copyState(s21, o), "changed");
  assert.equal(serializeNotesFile(parseNotesFile(text)), text);
});

test("private copy: updating it on one device merges with an edit on another", () => {
  const base = { notes: [{ ...byId("s21") }] };
  const updated = { notes: [{ ...byId("s21"), body: byId("s09").body, copied: byId("s09").modified, modified: "2026-10-14T09:00Z" }] };
  const other = { notes: [{ ...byId("s21"), due: "2026-10-25", modified: "2026-10-13T09:00Z" }] };
  const merged = mergeNotesFiles(base, updated, other).file.notes[0];
  assert.equal(merged.copied, byId("s09").modified);
  assert.equal(merged.body, byId("s09").body);
  assert.equal(merged.due, "2026-10-25");
});

test("line diff: the lines only the copy has, only the original has, and both", () => {
  const ops = lineDiff("a\nb\nc\nd", "a\nB\nc\nd\ne");
  assert.deepEqual(ops, [
    { type: "same", text: "a" }, { type: "del", text: "b" }, { type: "add", text: "B" },
    { type: "same", text: "c" }, { type: "same", text: "d" }, { type: "add", text: "e" },
  ]);
  assert.deepEqual(diffCounts(ops), { del: 1, add: 2 });
  assert.deepEqual(lineDiff("x", "x"), [{ type: "same", text: "x" }]);
  const sample = lineDiff(byId("s21").body, byId("s09").body);
  assert.deepEqual(diffCounts(sample), { del: 4, add: 2 });
  assert.equal(sample.filter(o => o.type !== "del").map(o => o.text).join("\n"), byId("s09").body);
  assert.equal(sample.filter(o => o.type !== "add").map(o => o.text).join("\n"), byId("s21").body);
});

test("line diff: long unchanged runs fold, side by side pairs a changed run", () => {
  const ops = lineDiff("1\n2\n3\n4\n5\n6\n7\nx\n8", "1\n2\n3\n4\n5\n6\n7\ny\n8");
  const folded = foldSame(ops, 2);
  assert.deepEqual(folded[0], { type: "fold", count: 5 });
  assert.deepEqual(folded.slice(1).map(o => o.text), ["6", "7", "x", "y", "8"]);
  assert.deepEqual(foldSame(lineDiff("a\nb", "a\nc")), lineDiff("a\nb", "a\nc"));
  const rows = sideBySide(folded);
  assert.deepEqual(rows[0], { fold: 5 });
  assert.deepEqual(rows[3], { left: { type: "del", text: "x" }, right: { type: "add", text: "y" } });
  assert.deepEqual(sideBySide(lineDiff("a", "a\nb"))[1], { left: null, right: { type: "add", text: "b" } });
});

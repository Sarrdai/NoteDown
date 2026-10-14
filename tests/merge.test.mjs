// Unit tests for the sync merge (app/js/core/merge.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNotesFile, serializeNotesFile } from "../app/js/core/notes-file.js";
import { toggleTask } from "../app/js/core/markdown.js";
import { mergeNotesFiles, applyDisplaced, moveNote } from "../app/js/core/merge.js";

const sample = parseNotesFile(readFileSync(new URL("../app/sample/notes.md", import.meta.url), "utf8"));
const [s01, s03] = ["s01", "s03"].map(id => sample.notes.find(n => n.id === id));
const file = (...notes) => ({ preamble: "", notes, moved: [] });
const edit = (note, task, modified) => ({ ...note, body: toggleTask(note.body, task), modified });
const byId = f => Object.fromEntries(f.notes.map(n => [n.id, n]));

test("file format: moved markers round-trip and stay out of the notes", () => {
  const text = serializeNotesFile({ preamble: "", notes: [s01], moved: [{ id: "s03", moved: "2026-10-13T09:00" }] });
  assert.match(text, /<!-- note id=s03 moved=2026-10-13T09:00 -->\n$/);
  const parsed = parseNotesFile(text);
  assert.deepEqual(parsed.notes.map(n => n.id), ["s01"]);
  assert.deepEqual(parsed.moved, [{ id: "s03", moved: "2026-10-13T09:00" }]);
});

test("merge: a change on one side is taken, unchanged notes stay", () => {
  const base = file(s01, s03);
  const local = file(edit(s01, 1, "2026-10-13T09:00"), s03);
  const { file: out, displaced } = mergeNotesFiles(base, local, base);
  assert.deepEqual(byId(out), byId(local));
  assert.deepEqual(displaced, []);
});

test("merge: keeps the remote order and appends local-only notes, so nothing new means the remote file", () => {
  const [a, b, c] = sample.notes;
  const remote = file(b, a);
  assert.deepEqual(mergeNotesFiles(file(a, b), file(a, b), remote).file.notes.map(n => n.id), [b.id, a.id]);
  assert.equal(serializeNotesFile(mergeNotesFiles(file(a, b), file(a, b), remote).file), serializeNotesFile(remote));
  assert.deepEqual(mergeNotesFiles(file(a, b), file(c, a, b), remote).file.notes.map(n => n.id), [b.id, a.id, c.id]);
});

test("merge: delete on one side wins over unchanged, an edit wins over delete", () => {
  const base = file(s01, s03);
  const deleted = mergeNotesFiles(base, file(s03), base).file;
  assert.deepEqual(deleted.notes.map(n => n.id), ["s03"]);
  const edited = edit(s01, 1, "2026-10-13T09:00");
  const kept = mergeNotesFiles(base, file(s03), file(edited, s03)).file;
  assert.deepEqual(byId(kept).s01, edited);
});

test("merge: status and text changed on different sides combine", () => {
  const closed = { ...s01, status: "closed", closed: "2026-10-13T09:30" };
  const edited = edit(s01, 1, "2026-10-13T09:10");
  const out = mergeNotesFiles(file(s01), file(closed), file(edited)).file;
  assert.equal(out.notes.length, 1);
  assert.deepEqual(out.notes[0], { ...edited, status: "closed", closed: "2026-10-13T09:30" });
});

test("merge: text changed on both sides keeps both versions", () => {
  const a = edit(s01, 1, "2026-10-13T09:10");
  const b = edit(s01, 2, "2026-10-13T09:20");
  const out = mergeNotesFiles(file(s01), file(a), file(b)).file;
  assert.equal(out.notes.length, 2);
  assert.deepEqual(out.notes.find(n => n.id === "s01"), b);
  const copy = out.notes.find(n => n.id !== "s01");
  assert.equal(copy.body, a.body);
  assert.equal(copy.created, s01.created);
});

test("merge: a note moved on one side and edited on the other follows the move", () => {
  const shared = file();
  const moved = moveNote(file(s01, s03), shared, "s01", "2026-10-13T09:00");
  const edited = edit(s01, 1, "2026-10-13T09:05");
  const { file: out, displaced } = mergeNotesFiles(file(s01, s03), file(edited, s03), moved.from);
  assert.deepEqual(out.notes.map(n => n.id), ["s03"]);
  assert.deepEqual(out.moved, [{ id: "s01", moved: "2026-10-13T09:00" }]);
  assert.deepEqual(displaced, [{ base: s01, note: edited }]);
  assert.deepEqual(applyDisplaced(moved.to, displaced[0]).notes, [edited]);
  // Not a member of the target any more: the edit lands in the private file.
  assert.deepEqual(applyDisplaced(file(s03), displaced[0]).notes, [s03, edited]);
});

test("merge: moving back removes the marker in the target", () => {
  const there = moveNote(file(s01), file(), "s01", "2026-10-13T09:00");
  const back = moveNote(there.to, there.from, "s01", "2026-10-13T10:00");
  assert.deepEqual(back.to.moved, []);
  assert.deepEqual(back.to.notes, [s01]);
  assert.deepEqual(back.from.moved, [{ id: "s01", moved: "2026-10-13T10:00" }]);
});

test("merge: a custom order changed on one side is taken; changed on both, the newer list wins", () => {
  const o = (ids, modified) => ({ ids, modified });
  const f = order => ({ notes: [], order });
  const base = f(o(["a"], "2026-10-14T08:00Z"));
  assert.deepEqual(mergeNotesFiles(base, f(o(["b", "a"], "2026-10-14T09:00Z")), base).file.order.ids, ["b", "a"]);
  assert.deepEqual(mergeNotesFiles(base, base, f(o(["c"], "2026-10-14T09:00Z"))).file.order.ids, ["c"]);
  const local = f(o(["l"], "2026-10-14T10:00Z")), remote = f(o(["r"], "2026-10-14T09:00Z"));
  assert.deepEqual(mergeNotesFiles(base, local, remote).file.order.ids, ["l"]);
  assert.deepEqual(mergeNotesFiles(f(null), f(null), remote).file.order.ids, ["r"]);
  assert.equal(mergeNotesFiles(f(null), f(null), f(null)).file.order, null);
});

// Unit tests for moving notes between files in the store (app/js/store.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNotesFile, serializeNotesFile } from "../app/js/core/notes-file.js";
import { state, replaceFiles, shareNotes, applyMerge, circleOf, sharedFiles, leaveNotes, allNotes, circleNotes, memberName, keptCircle, sharedCircles, removeNotes, trashNotes, restoreNotes, purgeNotes, purgeExpiredTrash, note, setStatuses } from "../app/js/store.js";

const sample = parseNotesFile(readFileSync(new URL("../app/sample/notes.md", import.meta.url), "utf8"));
const [n1, n2, n3] = sample.notes;
const start = () => replaceFiles({
  file: { preamble: "", notes: [{ ...n3 }], moved: [] },
  shared: [{ members: ["bob"], file: { preamble: "", notes: [{ ...n1 }], moved: [] } }, { members: ["lea"], file: { preamble: "", notes: [{ ...n2 }], moved: [] } }],
  sync: { enabled: true },
});
const texts = () => Object.fromEntries(sharedFiles().map(s => [s.key, serializeNotesFile(s.file)]));

test("merge across circles as a private copy never writes to a shared file", () => {
  start();
  const before = texts();
  const { note } = applyMerge([{ id: n1.id, body: n1.body }, { id: n2.id, body: n2.body }], { body: "merged", created: n1.created, due: null }, "copy");
  assert.deepEqual(circleOf(note.id), [], "the merged note is private");
  assert.deepEqual(texts(), before, "the shared files are untouched");
});

test("merge across circles with Share with ... puts the result into the file of everyone involved, created on first use", () => {
  start();
  const { note } = applyMerge([{ id: n1.id, body: null }, { id: n2.id, body: null }], { body: "merged", created: n1.created, due: null }, "share");
  assert.deepEqual(circleOf(note.id), ["bob", "lea"]);
  assert.deepEqual(sharedFiles().map(s => s.key), ["bob", "lea", "bob+lea"]);
});

test("sharing moves a note into the file of the new set and leaves a moved marker", () => {
  start();
  shareNotes([n3.id], ["bob", "lea"]);
  assert.deepEqual(circleOf(n3.id), ["bob", "lea"]);
  assert.deepEqual(state.file.moved.map(m => m.id), [n3.id]);
  shareNotes([n3.id], ["lea"]);   // removing bob moves it on
  assert.deepEqual(circleOf(n3.id), ["lea"]);
  assert.deepEqual(sharedFiles().find(s => s.key === "bob+lea").file.moved.map(m => m.id), [n3.id]);
});

test("leaving marks the note, hides it everywhere here and Undo brings it back", () => {
  start();
  replaceFiles({ file: state.file, shared: state.shared, sync: { enabled: true, identity: "me" } });
  const undo = leaveNotes([n1.id]);
  assert.equal(allNotes().some(n => n.id === n1.id), false, "hidden");
  assert.equal(circleNotes("bob").length, 0);
  assert.deepEqual(sharedFiles().find(s => s.key === "bob").file.notes[0].left, ["me"]);
  assert.match(texts().bob, / left=me -->/);
  leaveNotes([n3.id]);
  assert.equal(state.file.notes[0].left, undefined, "a private note can't be left");
  undo();
  assert.equal(allNotes().some(n => n.id === n1.id), true);
  assert.doesNotMatch(texts().bob, /left=/);
});

test("member names: a non-contact member's name comes from the shared file", () => {
  start();
  state.shared[0].file.members = [{ id: "zed", name: "Zed" }];
  assert.equal(memberName("zed"), "Zed");
  assert.equal(memberName("nobody"), undefined);
});

test("deleting a private note marks it in place: gone from the views, in the trash; Undo takes it back", () => {
  start();
  const undo = removeNotes([n3.id]);
  assert.equal(allNotes().some(n => n.id === n3.id), false);
  assert.deepEqual(trashNotes().map(n => n.id), [n3.id]);
  assert.ok(note(n3.id).deleted, "marked with the time");
  assert.equal(state.file.notes.length, 1, "still in the private file");
  undo();
  assert.equal(note(n3.id).deleted, undefined);
  assert.deepEqual(trashNotes(), []);
});

test("deleting a shared note takes it out of its file and keeps it in the own trash, marked with its circle", () => {
  start();
  const undo = removeNotes([n1.id]);
  const bob = sharedFiles().find(s => s.key === "bob").file;
  assert.deepEqual(bob.notes, [], "deleted for everyone in the circle");
  assert.deepEqual(bob.moved, [], "no moved marker: the others' devices see a delete");
  assert.equal(note(n1.id).kept, "bob");
  assert.deepEqual(keptCircle(n1.id), ["bob"]);
  assert.deepEqual(circleNotes("bob").map(n => n.id), [n1.id], "shown in its circle's trash");
  assert.equal(circleNotes("").some(n => n.id === n1.id), false, "not under Private");
  undo();
  assert.deepEqual(circleOf(n1.id), ["bob"]);
  assert.deepEqual(trashNotes(), []);
});

test("Restore puts a shared note back into its circle, as own note into the private file; Undo returns it to the trash", () => {
  start();
  removeNotes([n1.id]);
  let undo = restoreNotes([n1.id]);
  assert.deepEqual(circleOf(n1.id), ["bob"], "back in the circle's file");
  assert.equal(note(n1.id).deleted, undefined);
  undo();
  assert.deepEqual(circleOf(n1.id), [], "in the trash again");
  assert.equal(note(n1.id).kept, "bob");
  undo = restoreNotes([n1.id], { own: true });
  assert.deepEqual(circleOf(n1.id), []);
  assert.deepEqual(circleNotes("").map(n => n.id).sort(), [n1.id, n3.id].sort(), "now a private note");
  undo();
  assert.equal(note(n1.id).kept, "bob");
  assert.ok(sharedCircles().some(m => m.join("+") === "bob"));
});

test("Delete permanently and expiry remove trashed notes for good", () => {
  start();
  removeNotes([n1.id, n3.id]);
  const undo = purgeNotes([n1.id]);
  assert.equal(note(n1.id), undefined);
  undo();
  assert.ok(note(n1.id));
  purgeExpiredTrash(Date.now() + 31 * 86400000);
  assert.deepEqual(trashNotes(), []);
});

test("a note merged from a permanent one is permanent", () => {
  start();
  setStatuses([n1.id], "permanent");
  const { note: merged } = applyMerge([{ id: n1.id, body: null }, { id: n3.id, body: null }], { body: "merged", created: n1.created, due: null }, "copy");
  assert.equal(merged.status, "permanent");
});

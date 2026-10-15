// Unit tests for moving notes between files in the store (app/js/store.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNotesFile, serializeNotesFile } from "../app/js/core/notes-file.js";
import { state, replaceFiles, shareNotes, applyMerge, circleOf, sharedFiles, leaveNotes, allNotes, circleNotes, memberName, keptCircle, restoreKept, keepAsOwn, sharedCircles } from "../app/js/store.js";

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

test("a kept note shows in its circle, not under Private; Restore shares it again, Undo keeps it again", () => {
  start();
  state.file.notes[0].kept = "bob+lea";   // n3: the others deleted it, this device protected it
  assert.deepEqual(keptCircle(n3.id), ["bob", "lea"]);
  assert.deepEqual(circleOf(n3.id), [], "it lives in the private file");
  assert.deepEqual(circleNotes("bob+lea").map(n => n.id), [n3.id], "shown in its circle");
  assert.equal(circleNotes("").length, 0, "not under Private");
  assert.ok(sharedCircles().some(m => m.join("+") === "bob+lea"), "its circle is listed although it has no file");
  const undo = restoreKept(n3.id);
  assert.deepEqual(circleOf(n3.id), ["bob", "lea"], "back in the circle's file");
  assert.equal(note3().kept, undefined);
  assert.deepEqual(state.file.moved.map(m => m.id), [n3.id]);
  undo();
  assert.deepEqual(circleOf(n3.id), []);
  assert.equal(note3().kept, "bob+lea");
});

test("Keep as my own note drops the mark; sharing a kept note elsewhere drops it too, Undo brings it back", () => {
  start();
  state.file.notes[0].kept = "bob+lea";
  const undo = keepAsOwn(n3.id);
  assert.equal(note3().kept, undefined);
  assert.deepEqual(circleNotes("").map(n => n.id), [n3.id], "now under Private");
  undo();
  assert.equal(note3().kept, "bob+lea");
  const unshare = shareNotes([n3.id], ["bob"]);
  assert.equal(note3().kept, undefined, "shared on purpose: no longer kept");
  unshare();
  assert.equal(note3().kept, "bob+lea");
});

function note3() { return allNotes().find(n => n.id === n3.id); }

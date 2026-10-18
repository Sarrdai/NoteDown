// Unit tests for moving notes between files in the store (app/js/store.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNotesFile, serializeNotesFile } from "../app/js/core/notes-file.js";
import { refOf } from "../app/js/core/note-ref.js";
import { state, replaceFiles, shareNotes, applyMerge, applyMergeInto, circleOf, sharedFiles, leaveNotes, allNotes, circleNotes, memberName, keptCircle, sharedCircles, removeNotes, trashNotes, restoreNotes, purgeNotes, purgeExpiredTrash, note, setStatuses, setBody } from "../app/js/store.js";

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
  assert.deepEqual(state.file.purged.map(m => m.id), [n1.id], "a note from a shared file leaves a purged marker");
  undo();
  assert.ok(note(n1.id));
  assert.deepEqual(state.file.purged, []);
  purgeExpiredTrash(Date.now() + 31 * 86400000);
  assert.deepEqual(trashNotes(), []);
  assert.deepEqual(state.file.purged.map(m => m.id), [n1.id], "only the shared note, not the private one");
});

test("a note merged from a permanent one is permanent", () => {
  start();
  setStatuses([n1.id], "permanent");
  const { note: merged } = applyMerge([{ id: n1.id, body: null }, { id: n3.id, body: null }], { body: "merged", created: n1.created, due: null }, "copy");
  assert.equal(merged.status, "permanent");
});

test("merge into a private note: a shared source keeps its part, a private target changes, Undo restores", () => {
  start();
  const before = texts();
  const old = note(n3.id).body;
  const undo = applyMergeInto(n3.id, "merged", [{ id: n1.id, body: null }]);
  assert.equal(note(n3.id).body, "merged");
  assert.deepEqual(texts(), before, "the shared source stays for bob");
  undo();
  assert.equal(note(n3.id).body, old);
});

test("merge into a shared note: a private source gives its part up", () => {
  replaceFiles({
    file: { preamble: "", notes: [{ ...n3 }], moved: [] },
    shared: [{ members: ["bob"], file: { preamble: "", notes: [{ ...n1 }], moved: [] } }],
    sync: { enabled: true },
  });
  const undo = applyMergeInto(n1.id, "merged", [{ id: n3.id, body: null }]);
  assert.equal(note(n3.id), undefined);
  assert.equal(note(n1.id).body, "merged");
  undo();
  assert.equal(note(n3.id).id, n3.id);
});

// ---------- the same note id in two shared files (backlog #63) ----------

const twin = () => replaceFiles({
  file: { preamble: "", notes: [{ ...n3 }], moved: [] },
  shared: [{ members: ["bob"], file: { preamble: "", notes: [{ ...n1 }], moved: [] } },
    { members: ["lea"], file: { preamble: "", notes: [{ ...n2, id: n1.id, body: "Lea's note" }], moved: [] } }],
  sync: { enabled: true },
});

test("two shared files with a note of the same id: both open, edit, close and share on their own", () => {
  twin();
  const [a, b] = ["bob", "lea"].map(k => circleNotes(k)[0]);
  assert.equal(allNotes().length, 3, "both show in the list");
  const refs = allNotes().map(n => refOf(n));
  assert.equal(new Set(refs).size, 3, "each has its own address");
  assert.equal(refOf(a), n1.id, "the first file keeps the plain id");
  assert.equal(refOf(b), `${n1.id}@lea`);
  assert.equal(note(refOf(b)).body, "Lea's note");
  assert.equal(note(refOf(a)).body, n1.body);
  assert.deepEqual(circleOf(refOf(a)), ["bob"]);
  assert.deepEqual(circleOf(refOf(b)), ["lea"]);
  setBody(refOf(b), "edited");
  assert.equal(a.body, n1.body, "the other note is untouched");
  assert.equal(b.body, "edited");
  setStatuses([refOf(b)], "closed");
  assert.equal(a.status, n1.status);
  assert.equal(b.status, "closed");
  shareNotes([refOf(b)], ["bob", "lea"]);
  assert.deepEqual(circleOf(refOf(b)), ["bob", "lea"], "shared on, the other stays in its file");
  assert.deepEqual(circleOf(refOf(a)), ["bob"]);
});

test("the address is neither written to a file nor copied along", () => {
  twin();
  assert.doesNotMatch(texts().lea, /@lea/);
  assert.equal(parseNotesFile(texts().lea).notes[0].id, n1.id);
  assert.equal(Object.keys(circleNotes("lea")[0]).includes("ref"), false);
});

test("deleting one of two notes with the same id leaves the other and restores to its own circle", () => {
  twin();
  const b = circleNotes("lea")[0];
  const undo = removeNotes([refOf(b)]);
  assert.deepEqual(circleNotes("bob").map(n => n.body), [n1.body], "the other file keeps its note");
  assert.equal(circleNotes("lea").filter(n => !n.deleted).length, 0);
  assert.deepEqual(trashNotes().filter(n => n.kept).map(n => n.kept), ["lea"]);
  restoreNotes(trashNotes().filter(n => n.kept).map(refOf));
  assert.deepEqual(circleNotes("lea").map(n => n.body), ["Lea's note"]);
  assert.deepEqual(circleNotes("bob").map(n => n.body), [n1.body]);
  undo();
});

test("merge and leave address the right one of two notes with the same id", () => {
  twin();
  replaceFiles({ file: state.file, shared: state.shared, sync: { enabled: true, identity: "me" } });
  const b = circleNotes("lea")[0];
  leaveNotes([refOf(b)]);
  assert.equal(circleNotes("bob").length, 1, "the bob note still shows");
  assert.equal(allNotes().some(n => n.body === "Lea's note"), false, "the lea note is left");
});

// ---------- merged sources leave moved markers (backlog #35) ----------

const bobPair = () => replaceFiles({
  file: { preamble: "", notes: [{ ...n3 }], moved: [] },
  shared: [{ members: ["bob"], file: { preamble: "", notes: [{ ...n1 }, { ...n2, id: "s-two" }], moved: [] } },
    { members: ["lea"], file: { preamble: "", notes: [{ ...n2 }], moved: [] } }],
  sync: { enabled: true, identity: "me" },
});
const bobFile = () => sharedFiles().find(s => s.key === "bob").file;

test("merging notes of a shared file leaves a moved marker per source, not a plain delete, and Undo takes them back", () => {
  bobPair();
  const { note: merged, undo } = applyMerge([{ id: n1.id, body: null }, { id: "s-two", body: null }], { body: "merged", created: n1.created, due: null });
  assert.deepEqual(bobFile().notes.map(n => n.id), [merged.id]);
  assert.deepEqual(bobFile().moved.map(m => m.id).sort(), [n1.id, "s-two"].sort());
  assert.deepEqual(bobFile().moved[0].to, ["bob", "me"], "the marker names the file the merged note is in");
  assert.match(texts().bob, new RegExp(`<!-- note id=${n1.id} moved=\\S+ to=bob\\+me -->`));
  undo();
  assert.deepEqual(bobFile().notes.map(n => n.id).sort(), [n1.id, "s-two"].sort());
  assert.deepEqual(bobFile().moved, []);
});

test("merging across circles with Share with ... marks the sources in both files; a private source needs none", () => {
  bobPair();
  applyMerge([{ id: n1.id, body: null }, { id: n2.id, body: null }, { id: n3.id, body: null }], { body: "merged", created: n1.created, due: null }, "share");
  assert.deepEqual(sharedFiles().map(s => [s.key, s.file.moved.map(m => m.id)]).filter(([k]) => k !== "bob+lea"), [["bob", [n1.id]], ["lea", [n2.id]]]);
  assert.deepEqual(state.file.moved, [], "the private file leaves none");
});

test("merging into a shared note marks the sources that gave up their part; a source that keeps it gets none", () => {
  bobPair();
  const undo = applyMergeInto(n1.id, "merged", [{ id: "s-two", body: null }, { id: n2.id, body: null }]);
  assert.deepEqual(bobFile().moved.map(m => m.id), ["s-two"]);
  assert.deepEqual(sharedFiles().find(s => s.key === "lea").file.moved, [], "the lea source keeps its part");
  undo();
  assert.deepEqual(bobFile().moved, []);
});

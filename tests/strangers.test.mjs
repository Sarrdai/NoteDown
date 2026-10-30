// Shared files from non-contacts, held back until accepted (app/js/core/strangers.js, app/js/store.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNotesFile, serializeNotesFile } from "../app/js/core/notes-file.js";
import { mergeNotesFiles } from "../app/js/core/merge.js";
import { memberLabel, isHeld, unrecordedKeys, withAccepted } from "../app/js/core/strangers.js";
import { state, replaceFiles, allNotes, circleNotes, sharedCircles, heldRequests, acceptShared, leaveHeld, isHeldFile, memberName } from "../app/js/store.js";

test("memberLabel: contacts keep their name, others show what they wrote with a suffix, deleted ones say so", () => {
  assert.equal(memberLabel({ contactName: "Lea", fileName: "Leah" }), "Lea");
  assert.equal(memberLabel({ fileName: "Quinn" }), "Quinn (not a contact)");
  assert.equal(memberLabel({}), "Unknown (not a contact)");
  assert.equal(memberLabel({ fileName: "Quinn", deleted: true }), "Quinn (deleted)");
  assert.equal(memberLabel({ contactName: "Lea", deleted: true }), "Lea (deleted)");
});

test("isHeld: only files without a contact among the members and without an accepted marker", () => {
  assert.equal(isHeld(["quinn"], ["lea"], []), true);
  assert.equal(isHeld(["quinn", "rae"], ["lea"], []), true);
  assert.equal(isHeld(["lea", "quinn"], ["lea"], []), false, "one contact is enough");
  assert.equal(isHeld(["quinn"], ["lea"], [{ id: "quinn", at: "t" }]), false, "accepted");
  assert.equal(isHeld(["quinn", "rae"], [], [{ id: "quinn+rae", at: "t" }]), false, "the marker is of the circle");
  assert.equal(isHeld(["quinn"], [], [{ id: "rae", at: "t" }]), true, "another file's marker");
  assert.equal(isHeld([], [], []), false, "the private file");
});

test("unrecordedKeys and withAccepted: files with a contact are recorded once", () => {
  const accepted = [{ id: "tom", at: "t" }];
  assert.deepEqual(unrecordedKeys([["lea"], ["tom"], ["quinn"], ["lea", "quinn"]], ["lea", "tom"], accepted), ["lea", "lea+quinn"]);
  assert.deepEqual(withAccepted(accepted, ["tom", "lea", "lea"], "t2"), [{ id: "tom", at: "t" }, { id: "lea", at: "t2" }]);
  assert.equal(withAccepted(accepted, ["tom"], "t2"), accepted);
});

test("accepted markers round-trip after the sources and merge per id, a removal stays", () => {
  const text = "<!-- source id=f1 name=Pebble -->\n\n<!-- accepted id=lea+quinn at=2026-10-30T08:00Z -->\n\n<!-- order modified=2026-10-14T09:00Z ids=a -->\n";
  const file = parseNotesFile(text);
  assert.deepEqual(file.accepted, [{ id: "lea+quinn", at: "2026-10-30T08:00Z" }]);
  assert.equal(serializeNotesFile(file), text.trim() + "\n");
  const base = { notes: [], accepted: [{ id: "a", at: "t" }, { id: "b", at: "t" }] };
  const local = { notes: [], accepted: [{ id: "a", at: "t" }, { id: "b", at: "t" }, { id: "c", at: "t" }] };
  const remote = { notes: [], accepted: [{ id: "a", at: "t" }] };
  assert.deepEqual(mergeNotesFiles(base, local, remote).file.accepted, [{ id: "a", at: "t" }, { id: "c", at: "t" }]);
});

const note = (id, body) => ({ id, status: "open", created: "2026-10-12T10:00Z", modified: "2026-10-12T10:00Z", due: null, body });
const start = (extra = {}) => replaceFiles({
  file: { preamble: "", notes: [note("p1", "Private")], moved: [], contacts: [{ id: "lea", name: "Lea", color: 1 }], ...extra },
  shared: [
    { members: ["lea"], file: { preamble: "", notes: [note("l1", "With Lea")], moved: [] } },
    { members: ["quinn"], file: { preamble: "", notes: [note("q1", "From Quinn")], moved: [], members: [{ id: "quinn", name: "Quinn" }] } },
  ],
  sync: { enabled: true, identity: "me" },
});

test("a file of non-contacts shows nowhere until accepted; contact files are recorded at once", () => {
  start();
  assert.deepEqual(allNotes().map(n => n.id).sort(), ["l1", "p1"]);
  assert.equal(circleNotes("quinn").length, 0);
  assert.equal(circleNotes(null).some(n => n.id === "q1"), false);
  assert.deepEqual(sharedCircles(), [["lea"]]);
  assert.deepEqual(heldRequests(), [{ key: "quinn", members: ["quinn"] }]);
  assert.equal(isHeldFile("quinn"), true);
  assert.equal(memberName("quinn"), "Quinn", "the card can still name them");
  assert.deepEqual(state.file.accepted.map(a => a.id), ["lea"], "the contact's file needs no card and is recorded");
});

test("Show: the file is an ordinary shared file from then on, also when the contact list changes", () => {
  start();
  acceptShared("quinn");
  assert.deepEqual(allNotes().map(n => n.id).sort(), ["l1", "p1", "q1"]);
  assert.deepEqual(heldRequests(), []);
  assert.deepEqual(state.file.accepted.map(a => a.id).sort(), ["lea", "quinn"]);
  state.file.contacts = [];   // the contact is removed later: both files stay as they are
  assert.deepEqual(allNotes().map(n => n.id).sort(), ["l1", "p1", "q1"]);
});

test("a contact removed later turns into a stranger in files the user already has, which stay as they are", () => {
  start();
  state.file.contacts = [];   // Lea is removed
  assert.deepEqual(allNotes().map(n => n.id).sort(), ["l1", "p1"]);
  assert.deepEqual(heldRequests().map(r => r.key), ["quinn"]);
});

test("Leave: the notes of a held file are marked left and the card goes; in the sample the file goes", () => {
  start();
  leaveHeld("quinn");
  assert.deepEqual(state.shared[1].file.notes[0].left, ["me"]);
  assert.deepEqual(heldRequests(), []);
  assert.equal(allNotes().some(n => n.id === "q1"), false);
  replaceFiles({ file: state.file, shared: state.shared.slice(0, 1).concat([{ members: ["rae"], file: { preamble: "", notes: [note("r1", "x")], moved: [] } }]), sync: { enabled: true, simulated: true, contacts: [{ id: "lea", name: "Lea", color: 1 }] } });
  assert.equal(heldRequests().length, 1);
  leaveHeld("rae");
  assert.deepEqual(state.shared.map(s => s.members), [["lea"]]);
});

test("a held file without visible notes asks nothing", () => {
  start();
  state.shared[1].file.notes = [];
  assert.deepEqual(heldRequests(), []);
});

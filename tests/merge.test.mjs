// Unit tests for the sync merge (app/js/core/merge.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNotesFile, serializeNotesFile } from "../app/js/core/notes-file.js";
import { toggleTask } from "../app/js/core/markdown.js";
import { mergeNotesFiles, applyDisplaced, moveNote, deletedFromShared, adoptNotes, movedAway, renameDuplicates, hasLeft, rehomeTarget, rehomeNote, moveTarget } from "../app/js/core/merge.js";

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

test("merge: text changed on different lines on both sides combines (backlog #47)", () => {
  const a = edit(s01, 1, "2026-10-13T09:10");
  const b = edit(s01, 2, "2026-10-13T09:20");
  const out = mergeNotesFiles(file(s01), file(a), file(b)).file;
  assert.equal(out.notes.length, 1);
  assert.deepEqual(out.notes[0], { ...b, body: toggleTask(a.body, 2) });
});

test("merge: the same line changed differently on both sides keeps both versions", () => {
  const coffee = s01.body.split("\n").find(l => l.startsWith("- [ ] Coffee"));
  const a = { ...s01, body: s01.body.replace(coffee, coffee + " x2"), modified: "2026-10-13T09:10" };
  const b = { ...s01, body: s01.body.replace(coffee, coffee + " x3"), modified: "2026-10-13T09:20" };
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

test("moveTarget: names the target only when the move tells the old file's members nothing new (backlog #32)", () => {
  assert.deepEqual(moveTarget([], ["lea"], "me"), ["lea", "me"]);               // from the private file
  assert.deepEqual(moveTarget(["lea"], ["lea", "max"], "me"), ["lea", "max", "me"]);   // shared with one more
  assert.deepEqual(moveTarget(["lea", "max"], ["max"], "me"), ["max", "me"]);   // someone removed
  assert.deepEqual(moveTarget(["lea"], [], "me"), ["me"]);                      // back to the private file
  assert.equal(moveTarget(["lea"], ["tom"], "me"), undefined);                  // another circle entirely
});

test("merge: a moved marker with a target round-trips and travels with the displaced edit (backlog #32)", () => {
  const moved = moveNote(file(s01, s03), file(), "s01", "2026-10-13T09:00", ["lea", "me"]);
  const text = serializeNotesFile(moved.from);
  assert.match(text, /<!-- note id=s01 moved=2026-10-13T09:00 to=lea\+me -->/);
  assert.deepEqual(parseNotesFile(text).moved, [{ id: "s01", moved: "2026-10-13T09:00", to: ["lea", "me"] }]);
  const edited = edit(s01, 1, "2026-10-13T09:05");
  const { displaced } = mergeNotesFiles(file(s01, s03), file(edited, s03), parseNotesFile(text));
  assert.deepEqual(displaced, [{ base: s01, note: edited, to: ["lea", "me"] }]);
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

test("merge: contacts per id — the changed side wins, both new ones stay, a removal stays", () => {
  const lea = { id: "lea", name: "Lea", color: 2 };
  const tom = { id: "tom", name: "Tom", color: 4, pending: "2026-10-14T09:00Z" };
  const mia = { id: "mia", name: "Mia", color: 1 };
  const withContacts = contacts => ({ notes: [], contacts });
  const base = withContacts([lea, tom]);
  // This device sees Tom's confirmation (pending dropped) and renames Lea; the other adds Mia and removes nothing.
  const local = withContacts([{ ...lea, name: "Lea M." }, { id: "tom", name: "Tom", color: 4 }]);
  const remote = withContacts([lea, tom, mia]);
  const out = mergeNotesFiles(base, local, remote).file.contacts;
  assert.deepEqual(Object.fromEntries(out.map(c => [c.id, c])), {
    lea: { ...lea, name: "Lea M." }, tom: { id: "tom", name: "Tom", color: 4 }, mia,
  });
  // A contact removed on one side stays removed; changed on both, the remote one wins.
  assert.deepEqual(mergeNotesFiles(base, withContacts([tom]), base).file.contacts, [tom]);
  assert.deepEqual(mergeNotesFiles(base, base, withContacts([lea])).file.contacts, [lea]);
  const both = mergeNotesFiles(base, withContacts([{ ...lea, name: "L" }, tom]), withContacts([{ ...lea, name: "R" }, tom])).file.contacts;
  assert.equal(both.find(c => c.id === "lea").name, "R");
  // Files without contacts (shared files) merge to none.
  assert.deepEqual(mergeNotesFiles(file(), file(), file()).file.contacts, []);
});

test("deletedFromShared: a note deleted elsewhere comes back as a trash entry marked with its circle", () => {
  const base = file(s01, s03);
  const merged = mergeNotesFiles(base, base, file(s03)).file;   // another member deleted s01
  assert.deepEqual(deletedFromShared(base, merged, "lea+tom", "2026-10-13T09:00Z"), [{ ...s01, deleted: "2026-10-13T09:00Z", kept: "lea+tom" }]);
});

test("deletedFromShared: a note that moved on or was edited isn't trashed", () => {
  const base = file(s01, s03);
  const moved = moveNote(base, file(), "s01", "2026-10-13T09:00").from;
  assert.deepEqual(deletedFromShared(base, mergeNotesFiles(base, base, moved).file, "lea", "x"), [], "moved, not deleted");
  const edited = file(edit(s01, 1, "2026-10-13T09:05"), s03);
  assert.deepEqual(deletedFromShared(base, mergeNotesFiles(base, edited, file(s03)).file, "lea", "x"), [], "an edit wins over the delete");
});

test("purged markers: round-trip, survive the merge and keep a stale device from trashing the note again", () => {
  const trashed = { ...s01, deleted: "2026-10-01T09:00Z", kept: "lea" };
  const purged = { ...file(), purged: [{ id: "s01", purged: "2026-10-13T09:00Z" }] };
  const text = serializeNotesFile(purged);
  assert.match(text, /<!-- note id=s01 purged=2026-10-13T09:00Z -->/);
  assert.deepEqual(parseNotesFile(text).purged, purged.purged);
  assert.deepEqual(parseNotesFile(text).notes, []);
  // One device removed the trash entry for good; the other still has it unchanged.
  const merged = mergeNotesFiles(file(trashed), file(trashed), purged).file;
  assert.deepEqual([merged.notes, merged.purged], [[], purged.purged]);
  // A device that comes back after weeks finds s01 gone from the shared file: it stays out of the trash.
  const found = deletedFromShared(file(s01), file(), "lea", "2026-11-30T09:00Z");
  assert.deepEqual(adoptNotes(merged, found).notes, []);
  // Restored from the trash on another device meanwhile: the edit wins over the purge.
  const restored = { ...s01, modified: "2026-10-13T09:05Z" };
  assert.deepEqual(mergeNotesFiles(file(trashed), purged, file(restored)).file.notes, [restored]);
});

test("device markers: name and sync time round-trip; the later sync time wins", () => {
  const text = serializeNotesFile({ ...file(), devices: [{ id: "d1", name: "Pixel 8", synced: "2026-10-13T09:00Z" }, { id: "d2", synced: "2026-10-01T09:00Z" }] });
  assert.match(text, /<!-- device id=d1 name=Pixel%208 synced=2026-10-13T09:00Z -->/);
  assert.deepEqual(parseNotesFile(text).devices, [{ id: "d1", name: "Pixel 8", synced: "2026-10-13T09:00Z" }, { id: "d2", synced: "2026-10-01T09:00Z" }]);
  const base = { ...file(), devices: [{ id: "d1", name: "Phone", synced: "2026-10-01T09:00Z" }] };
  const renamed = { ...file(), devices: [{ id: "d1", name: "Pixel", synced: "2026-10-01T09:00Z" }] };
  const synced = { ...file(), devices: [{ id: "d1", name: "Phone", synced: "2026-10-14T09:00Z" }, { id: "d2", synced: "2026-10-14T08:00Z" }] };
  assert.deepEqual(mergeNotesFiles(base, renamed, synced).file.devices,
    [{ id: "d1", name: "Phone", synced: "2026-10-14T09:00Z" }, { id: "d2", synced: "2026-10-14T08:00Z" }]);
});

test("trash: deleted and kept round-trip and merge as one field group", () => {
  const trashed = { ...s01, deleted: "2026-10-13T09:00Z", kept: "lea+tom" };
  const text = serializeNotesFile(file(trashed));
  assert.match(text, / deleted=2026-10-13T09:00Z kept=lea\+tom -->/);
  assert.deepEqual(parseNotesFile(text).notes[0], trashed);
  // Restored as the user's own note on one device, edited in the trash on another: both survive.
  const own = { ...s01 };
  const edited = edit(trashed, 1, "2026-10-13T09:10");
  const out = mergeNotesFiles(file(trashed), file(own), file(edited)).file.notes[0];
  assert.equal(out.deleted, undefined, "restored");
  assert.equal(out.kept, undefined);
  assert.equal(out.body, edited.body, "the edit stays");
  // Deleted on one device, edited on the other: the note waits in the trash with the edit.
  const del = mergeNotesFiles(file(s01), file({ ...s01, deleted: "2026-10-13T09:00Z" }), file(edit(s01, 2, "2026-10-13T09:05"))).file.notes[0];
  assert.equal(del.deleted, "2026-10-13T09:00Z");
  assert.equal(del.body, edit(s01, 2, "x").body);
});

test("permanent: the status round-trips; an unknown one reads as open", () => {
  const p = { ...s01, status: "permanent" };
  assert.equal(parseNotesFile(serializeNotesFile(file(p))).notes[0].status, "permanent");
  assert.equal(parseNotesFile(serializeNotesFile(file(p)).replace("permanent", "weird")).notes[0].status, "open");
});

test("adoptNotes: the trash entry joins the private file once, a moved marker cleared", () => {
  const priv = { ...file(s03), moved: [{ id: "s01", moved: "2026-10-13T09:00" }] };
  const out = adoptNotes(priv, [s01]);
  assert.deepEqual(out.notes.map(n => n.id), ["s03", "s01"]);
  assert.deepEqual(out.moved, []);
  assert.deepEqual(adoptNotes(out, [{ ...s01, deleted: "x" }]).notes.map(n => n.id), ["s03", "s01"], "already there: left out");
});

test("movedAway: only a moved marker the base doesn't have counts", () => {
  const moved = moveNote(file(s01, s03), file(), "s01", "2026-10-13T09:00").from;
  assert.equal(movedAway(file(s01, s03), moved), true);
  assert.equal(movedAway(moved, moved), false);
  assert.equal(movedAway(file(s01), file(s01)), false);
});

test("renameDuplicates: a private copy of a note that is in a shared file again gets a new ID", () => {
  const { file: out, renamed } = renameDuplicates(file(s01, s03), new Set(["s01"]));
  assert.equal(renamed.length, 1);
  assert.equal(renamed[0].from, "s01");
  assert.notEqual(renamed[0].to, "s01");
  assert.deepEqual(out.notes.map(n => n.id), [renamed[0].to, "s03"]);
  assert.equal(out.notes[0].body, s01.body, "the text is kept");
  assert.deepEqual(renameDuplicates(file(s03), new Set(["s01"])).renamed, []);
});

test("file format: left and member markers round-trip", () => {
  const left = { ...s01, left: ["bob", "lea"] };
  const text = serializeNotesFile({ preamble: "", notes: [left, s03], moved: [], members: [{ id: "sam", name: "Sam Ö" }] });
  assert.match(text, / left=bob,lea -->/);
  assert.match(text, /<!-- member id=sam name=Sam%20%C3%96 -->/);
  const parsed = parseNotesFile(text);
  assert.deepEqual(parsed.notes.find(n => n.id === "s01").left, ["bob", "lea"]);
  assert.equal("left" in parsed.notes.find(n => n.id === "s03"), false, "no left attribute, no left field");
  assert.deepEqual(parsed.members, [{ id: "sam", name: "Sam Ö" }]);
});

test("merge: left is the union of both sides; a change of left alone is taken", () => {
  const base = file(s01);
  const bob = file({ ...s01, left: ["bob"] });
  assert.deepEqual(mergeNotesFiles(base, bob, base).file.notes[0].left, ["bob"]);
  assert.deepEqual(mergeNotesFiles(base, base, bob).file.notes[0].left, ["bob"]);
  const lea = file({ ...s01, left: ["lea"] });
  assert.deepEqual(mergeNotesFiles(base, bob, lea).file.notes[0].left, ["bob", "lea"]);
  // Left on one side, edited on the other: both stay.
  const edited = file(edit(s01, 1, "2026-10-13T09:00"));
  const out = mergeNotesFiles(base, bob, edited).file.notes[0];
  assert.deepEqual(out.left, ["bob"]);
  assert.equal(out.body, edited.notes[0].body);
});

test("merge: member names per id — each member's own marker is taken, a removal stays", () => {
  const f = members => ({ ...file(), members });
  const out = mergeNotesFiles(f([{ id: "a", name: "A" }]), f([{ id: "a", name: "A" }, { id: "b", name: "Bea" }]), f([{ id: "a", name: "Ann" }])).file;
  assert.deepEqual(out.members, [{ id: "a", name: "Ann" }, { id: "b", name: "Bea" }]);
});

test("rehomeTarget: a remaining member moves a note someone left to the file of the others; a leaver doesn't", () => {
  const left = { ...s01, left: ["bob"] };
  assert.deepEqual(rehomeTarget(left, ["bob", "lea", "me"], "me"), { others: ["lea"] });
  assert.deepEqual(rehomeTarget({ ...s01, left: ["bob", "lea"] }, ["bob", "lea", "me"], "me"), { others: [] }, "one member left: private");
  assert.equal(rehomeTarget(left, ["bob", "lea", "me"], "bob"), null, "the leaver's own device does nothing");
  assert.equal(rehomeTarget(s01, ["bob", "me"], "me"), null);
  assert.equal(hasLeft(left, "bob"), true);
  assert.equal(hasLeft(left, "me"), false);
  assert.equal(hasLeft(left, ""), false);
});

test("rehomeNote: the note drops left, the old file keeps a moved marker", () => {
  const left = { ...s01, left: ["bob"] };
  const { from, to } = rehomeNote(file(left, s03), file(), "s01", "2026-10-14T10:00Z");
  assert.deepEqual(from.notes.map(n => n.id), ["s03"]);
  assert.deepEqual(from.moved, [{ id: "s01", moved: "2026-10-14T10:00Z" }]);
  assert.equal("left" in to.notes[0], false);
  assert.equal(to.notes[0].body, s01.body);
});

test("merged source (backlog #35): the other member sees a move, no trash entry; a concurrent edit lands as a displaced edit", () => {
  const merged = { ...s03, id: "m1" };
  const base = file(s01, s03);
  const remote = { ...file(merged), moved: [{ id: "s01", moved: "2026-10-13T10:00", to: ["bob", "me"] }, { id: "s03", moved: "2026-10-13T10:00", to: ["bob", "me"] }] };
  const local = file(edit(s01, 1, "2026-10-13T09:00"), s03);
  const out = mergeNotesFiles(base, local, remote);
  assert.deepEqual(out.file.notes.map(n => n.id), ["m1"]);
  assert.deepEqual(out.file.moved.map(m => m.id).sort(), ["s01", "s03"]);
  assert.deepEqual(deletedFromShared(local, out.file, "bob", "2026-10-13T11:00"), [], "no trash entry for a moved source");
  assert.deepEqual(out.displaced.map(d => [d.note.id, d.to]), [["s01", ["bob", "me"]]]);
});

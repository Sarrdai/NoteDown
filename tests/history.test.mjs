// Restoring an older state of a file (app/js/core/history.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNotesFile } from "../app/js/core/notes-file.js";
import { restoredFile, compareStates, changeSummary, stateTime } from "../app/js/core/history.js";

const sample = () => parseNotesFile(readFileSync(new URL("../app/sample/notes.md", import.meta.url), "utf8"));

test("restoredFile: the notes and their order come back, the file's other parts stay", () => {
  const old = sample();
  old.order = { ids: old.notes.map(n => n.id).reverse(), modified: "2026-10-01T08:00:00Z" };
  const current = sample();
  current.notes = current.notes.slice(2);
  current.order = null;
  current.contacts = [{ id: "c1", name: "Contact" }];
  current.devices = [{ id: "d1", name: "Device" }];
  current.members = [{ id: "m1", name: "Member" }];
  current.news = [{ id: "n1", seen: "2026-10-14T08:00:00Z" }];
  const file = restoredFile(current, old);
  assert.deepEqual(file.notes.map(n => n.id), old.notes.map(n => n.id));
  assert.deepEqual(file.order, old.order);
  for (const part of ["contacts", "devices", "members", "news", "preamble"]) assert.deepEqual(file[part], current[part], part);
});

test("restoredFile: a note moved into another file since stays there; a purged marker of a note that comes back goes", () => {
  const old = sample();
  const [moved, purged, kept] = old.notes.map(n => n.id);
  const current = { ...sample(), notes: [], moved: [{ id: moved, moved: "2026-10-10T08:00:00Z" }],
    purged: [{ id: purged, purged: "2026-10-11T08:00:00Z" }, { id: "gone", purged: "2026-10-11T08:00:00Z" }] };
  const file = restoredFile(current, old);
  assert.ok(!file.notes.some(n => n.id === moved));
  assert.ok(file.notes.some(n => n.id === purged) && file.notes.some(n => n.id === kept));
  assert.deepEqual(file.purged.map(m => m.id), ["gone"]);
  assert.deepEqual(file.moved, current.moved);
});

test("compareStates: notes back, gone, changed and the same; trashed notes count as gone", () => {
  const old = sample(), current = sample();
  const [a, b, c, d] = current.notes.filter(n => !n.deleted).map(n => n.id);
  current.notes = current.notes.filter(n => n.id !== a);                               // deleted since: comes back
  current.notes = current.notes.map(n => (n.id === b ? { ...n, deleted: "2026-10-14T08:00:00Z" } : n));   // trashed since: comes back
  current.notes = current.notes.map(n => (n.id === c ? { ...n, body: n.body + "\n\n" + old.notes.find(x => x.id === d).body } : n));
  old.notes = old.notes.filter(n => n.id !== d);                                        // added since: goes
  const diff = compareStates(current, old);
  assert.deepEqual(diff.back.map(n => n.id).sort(), [a, b].sort());
  assert.deepEqual(diff.gone.map(n => n.id), [d]);
  assert.deepEqual(diff.changed.map(x => x.before.id), [c]);
  assert.equal(diff.same, old.notes.filter(n => !n.deleted).length - 3);
  assert.equal(changeSummary(diff), "2 notes back · 1 newer note goes · 1 changed");
  assert.equal(changeSummary(compareStates(old, old)), "Same notes as now");
});

test("stateTime: today, yesterday, then the date", () => {
  const now = new Date("2026-10-15T14:00:00Z");
  assert.equal(stateTime("2026-10-15T09:12:00Z", now, "UTC"), "Today, 09:12");
  assert.equal(stateTime("2026-10-14T18:40:00Z", now, "UTC"), "Yesterday, 18:40");
  assert.equal(stateTime("2026-10-12T08:00:00Z", now, "UTC"), "Mon 12 Oct, 08:00");
});

// Unit tests for moving notes between files in the store (app/js/store.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNotesFile, serializeNotesFile } from "../app/js/core/notes-file.js";
import { state, replaceFiles, shareNotes, applyMerge, circleOf, sharedFiles } from "../app/js/store.js";

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

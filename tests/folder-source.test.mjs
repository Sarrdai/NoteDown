// Folder sources (app/js/core/folder-source.js): reading a file into a note, the filter keys, and the
// source markers and `source=` attribute in the notes file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileNote, isNoteFile, sourceKey, sourceIdOf } from "../app/js/core/folder-source.js";
import { parseNotesFile, serializeNotesFile, timestamp } from "../app/js/core/notes-file.js";
import { mergeNotesFiles } from "../app/js/core/merge.js";

test("a file in the Pebble app's format loses its front matter and takes its created time", () => {
  const text = "---\ncreated: 2026-10-19T09:15\ntags: [index]\n---\n\nPick up the jackets on Thursday.\n";
  const { body, created } = fileNote(text, 0);
  assert.equal(body, "Pick up the jackets on Thursday.");
  assert.equal(created, timestamp(new Date("2026-10-19T09:15")));   // local time without a zone
});

test("without front matter the whole text is the note and the file's time its created time", () => {
  const at = Date.UTC(2026, 9, 18, 7, 30);
  assert.deepEqual(fileNote("﻿Line one\r\nLine two\r\n", at), { body: "Line one\nLine two", created: "2026-10-18T07:30Z" });
});

test("an invalid created time falls back to the file's time; an empty file has no body", () => {
  const at = Date.UTC(2026, 9, 18, 7, 30);
  assert.equal(fileNote("---\ncreated: soon\n---\nText", at).created, "2026-10-18T07:30Z");
  assert.equal(fileNote("---\ntags: [index]\n---\n\n", at).body, "");
});

test("a horizontal rule later in the text is not front matter", () => {
  assert.equal(fileNote("Intro\n---\nMore", 1).body, "Intro\n---\nMore");
});

test("only Markdown and text files are read", () => {
  assert.ok(isNoteFile("2026-10-19 0915.md"));
  assert.ok(isNoteFile("memo.TXT"));
  assert.ok(!isNoteFile("recording.m4a"));
});

test("filter keys of sources", () => {
  assert.equal(sourceIdOf(sourceKey("f1")), "f1");
  assert.equal(sourceIdOf("@news"), null);
  assert.equal(sourceIdOf(""), null);
  assert.equal(sourceIdOf(null), null);
});

test("source markers and the note's source survive a round trip", () => {
  const text = "<!-- note id=a status=open created=2026-10-19T09:15Z modified=2026-10-19T09:15Z source=f1 -->\nPick up the jackets.\n\n"
    + "<!-- source id=f1 name=Pebble%20ring -->\n";
  const file = parseNotesFile(text);
  assert.deepEqual(file.sources, [{ id: "f1", name: "Pebble ring" }]);
  assert.equal(file.notes[0].source, "f1");
  assert.equal(serializeNotesFile(file), text);
});

test("sources merge per id; a removal on one side stays", () => {
  const base = { notes: [], sources: [{ id: "f1", name: "Pebble" }, { id: "f2", name: "Inbox" }] };
  const local = { notes: [], sources: [{ id: "f1", name: "Ring" }, { id: "f2", name: "Inbox" }] };
  const remote = { notes: [], sources: [{ id: "f1", name: "Pebble" }] };
  assert.deepEqual(mergeNotesFiles(base, local, remote).file.sources, [{ id: "f1", name: "Ring" }]);
});

// Unit tests for the encrypted backup (app/js/core/backup.js, backlog #56) and the screen lock's timing
// (app/js/core/app-lock.js, backlog #6). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNotesFile } from "../app/js/core/notes-file.js";
import { generateBackupKey, normalizeBackupKey, backupContents, sealBackup, openBackup, notesToRestore, backupFileName, BackupError } from "../app/js/core/backup.js";
import { lockDue, lockSummary, DEFAULT_LOCK } from "../app/js/core/app-lock.js";

const sample = parseNotesFile(readFileSync(new URL("../app/sample/notes.md", import.meta.url), "utf8"));
const [n1, n2, ...rest] = sample.notes.filter(n => !n.deleted);
const FAST = { iterations: 1000 };

test("a backup key is 30 digits in groups of five, typed back with any separators", () => {
  const key = generateBackupKey();
  assert.match(key, /^(\d{5} ){5}\d{5}$/);
  assert.equal(normalizeBackupKey(key.replaceAll(" ", "-")), key.replaceAll(" ", ""));
  assert.equal(normalizeBackupKey("123"), null);
  assert.notEqual(generateBackupKey(), key);
});

test("a backup opens only with its key, holds the notes and settings, and shows no note text", async () => {
  const key = generateBackupKey();
  const contents = backupContents({ file: { notes: rest }, shared: [{ members: ["lea"], file: { notes: [n1] } }], settings: { flavor: "mocha" } }, "2026-10-17T10:00:00Z");
  const bytes = await sealBackup(contents, key, FAST);
  assert.ok(!new TextDecoder().decode(bytes).includes(n1.body.split("\n")[0]), "no plain text");
  const back = await openBackup(bytes, key);
  assert.equal(back.file, contents.file);
  assert.deepEqual(back.shared, contents.shared);
  assert.equal(back.settings.flavor, "mocha");
  await assert.rejects(openBackup(bytes, generateBackupKey()), BackupError);
  await assert.rejects(openBackup(new TextEncoder().encode("## a note"), key), /isn't a NoteDown backup/);
  const changed = bytes.slice(); changed[changed.length - 1] ^= 1;
  await assert.rejects(openBackup(changed, key), /doesn't fit/);
});

test("restoring adds only the notes missing here, shared ones as private, never the trash", () => {
  const contents = backupContents({
    file: { notes: [n2, { ...rest[0], deleted: "2026-10-01T00:00:00Z" }] },
    shared: [{ members: ["lea"], file: { notes: [{ ...n1, left: ["x"] }] } }],
    settings: {},
  }, "2026-10-17T10:00:00Z");
  const notes = notesToRestore(contents, [n2.id]);
  assert.deepEqual(notes.map(n => n.id), [n1.id]);
  assert.equal(notes[0].left, undefined, "no sharing marks");
  assert.equal(backupFileName("2026-10-17"), "notedown-backup-2026-10-17.ndbackup");
});

test("the screen lock locks after the chosen time away, not for NoteDown's own share sheet", () => {
  const lock = { on: true, after: 60 };
  assert.equal(lockDue(DEFAULT_LOCK, 0, 10 ** 9), false, "off");
  assert.equal(lockDue(lock, 1000, 1000 + 59000), false);
  assert.equal(lockDue(lock, 1000, 1000 + 60000), true);
  assert.equal(lockDue({ on: true, after: 0 }, 1000, 1001), true, "immediately");
  assert.equal(lockDue(lock, 1000, 10 ** 9, true), false, "expected: the share sheet");
  assert.equal(lockSummary(lock), "After 1 minute");
  assert.equal(lockSummary(DEFAULT_LOCK), "Off");
});

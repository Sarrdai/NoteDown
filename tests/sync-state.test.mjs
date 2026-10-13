// Unit tests for the sync client's small decisions (app/js/core/sync-state.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNotesFile, createNote } from "../app/js/core/notes-file.js";
import { onlyUntouchedWelcome, deviceRows, keyHolders, WELCOME_PREFIX } from "../app/js/core/sync-state.js";

const welcomeBody = readFileSync(new URL("../app/welcome.md", import.meta.url), "utf8").trim();
const sample = parseNotesFile(readFileSync(new URL("../app/sample/notes.md", import.meta.url), "utf8"));
const file = (...notes) => ({ preamble: "", notes, moved: [] });
const welcome = createNote(welcomeBody, "2026-10-13T08:00Z", WELCOME_PREFIX + "abc");

test("onlyUntouchedWelcome: the fresh welcome note alone", () => {
  assert.equal(onlyUntouchedWelcome(file(welcome)), true);
});

test("onlyUntouchedWelcome: edited, closed, or with other notes it counts as the user's", () => {
  assert.equal(onlyUntouchedWelcome(file({ ...welcome, modified: "2026-10-13T09:00Z" })), false);
  assert.equal(onlyUntouchedWelcome(file({ ...welcome, status: "closed" })), false);
  assert.equal(onlyUntouchedWelcome(file(welcome, sample.notes[0])), false);
  assert.equal(onlyUntouchedWelcome(file(sample.notes[0])), false);
  assert.equal(onlyUntouchedWelcome(file()), false);
});

const dev = (id, kind = "device", active = true) => [id, { id, kind, active }];

test("deviceRows: this device first, the others numbered by when they were added", () => {
  const devices = new Map([dev("a"), dev("r", "recovery"), dev("b"), dev("c", "device", false), dev("d")]);
  assert.deepEqual(deviceRows(devices, "b"), [
    { id: "b", own: true, label: "This device" },
    { id: "a", own: false, label: "Device 1" },
    { id: "d", own: false, label: "Device 4" },
  ]);
});

test("keyHolders: every active device including the recovery device", () => {
  const devices = new Map([dev("a"), dev("r", "recovery"), dev("c", "device", false)]);
  assert.deepEqual(keyHolders(devices).map(d => d.id), ["a", "r"]);
});

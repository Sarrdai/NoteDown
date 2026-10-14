// Unit tests for the sync client's small decisions (app/js/core/sync-state.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNotesFile, createNote } from "../app/js/core/notes-file.js";
import { onlyUntouchedWelcome, deviceRows, keyHolders, withDeviceName, storageUsage, nextPollDelay, WELCOME_PREFIX } from "../app/js/core/sync-state.js";

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
    { id: "b", own: true, named: false, label: "This device" },
    { id: "a", own: false, named: false, label: "Device 1" },
    { id: "d", own: false, named: false, label: "Device 4" },
  ]);
});

test("deviceRows: names from the private file, removed devices' names ignored", () => {
  const devices = new Map([dev("a"), dev("r", "recovery"), dev("b"), dev("c", "device", false)]);
  const names = [{ id: "a", name: "Chrome on Windows" }, { id: "b", name: "NoteDown app on Android" }, { id: "c", name: "Firefox on Linux" }];
  assert.deepEqual(deviceRows(devices, "b", names), [
    { id: "b", own: true, named: true, label: "NoteDown app on Android" },
    { id: "a", own: false, named: true, label: "Chrome on Windows" },
  ]);
});

test("withDeviceName: sets, replaces and removes a device name", () => {
  const named = withDeviceName(file(), "a", "Chrome on Windows");
  assert.deepEqual(named.devices, [{ id: "a", name: "Chrome on Windows" }]);
  assert.deepEqual(withDeviceName(named, "a", "Firefox on Linux").devices, [{ id: "a", name: "Firefox on Linux" }]);
  assert.deepEqual(withDeviceName(named, "a", null).devices, []);
});

test("keyHolders: every active device including the recovery device", () => {
  const devices = new Map([dev("a"), dev("r", "recovery"), dev("c", "device", false)]);
  assert.deepEqual(keyHolders(devices).map(d => d.id), ["a", "r"]);
});

test("storageUsage: text, share and level of the storage bar", () => {
  const MB = 1024 * 1024;
  assert.deepEqual(storageUsage({ used: 0.4 * MB, quota: 2 * MB }), { text: "0.4 MB of 2 MB used", fraction: 0.2, percent: 20, level: "ok" });
  assert.equal(storageUsage({ used: 0, quota: 2 * MB }).text, "< 0.1 MB of 2 MB used");
  assert.equal(storageUsage({ used: 0.06 * MB, quota: 2 * MB }).text, "0.1 MB of 2 MB used");
  assert.equal(storageUsage({ used: 1.5 * MB, quota: 2 * MB }).level, "ok");
  assert.equal(storageUsage({ used: 1.6 * MB, quota: 2 * MB }).level, "warn");
  const full = storageUsage({ used: 2 * MB, quota: 2 * MB });
  assert.deepEqual([full.level, full.fraction, full.text], ["full", 1, "2 MB of 2 MB used"]);
  assert.equal(storageUsage({ used: 3 * MB, quota: 2 * MB }).fraction, 1);
});

test("nextPollDelay: 5, 10, 20, 30 s while nothing changes, back to 5 s on a change", () => {
  const delays = [5000];
  for (let i = 0; i < 5; i++) delays.push(nextPollDelay(delays.at(-1), false));
  assert.deepEqual(delays, [5000, 10000, 20000, 30000, 30000, 30000]);
  assert.equal(nextPollDelay(30000, true), 5000);
  assert.equal(nextPollDelay(5000, true), 5000);
  assert.equal(nextPollDelay(0, false), 5000, "never below the minimum");
});

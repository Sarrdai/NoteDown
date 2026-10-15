// Unit tests for the sync client's small decisions (app/js/core/sync-state.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNotesFile, createNote } from "../app/js/core/notes-file.js";
import { onlyUntouchedWelcome, matchFiles, fileMembers, allKeyHolders, hasContent, deviceRows, keyHolders, withDeviceName, storageUsage, limitRefusal, nextPollDelay, serverRestored, WELCOME_PREFIX } from "../app/js/core/sync-state.js";

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
  const refused = storageUsage({ used: 1.2 * MB, quota: 2 * MB }, true);
  assert.deepEqual([refused.level, refused.percent, refused.text], ["full", 100, "1.2 MB of 2 MB used"]);
});

test("nextPollDelay: 5, 10, 20, 30 s while nothing changes, back to 5 s on a change", () => {
  const delays = [5000];
  for (let i = 0; i < 5; i++) delays.push(nextPollDelay(delays.at(-1), false));
  assert.deepEqual(delays, [5000, 10000, 20000, 30000, 30000, 30000]);
  assert.equal(nextPollDelay(30000, true), 5000);
  assert.equal(nextPollDelay(5000, true), 5000);
  assert.equal(nextPollDelay(0, false), 5000, "never below the minimum");
});

test("matchFiles: the file of the user alone is private, the others are shared files by circle", () => {
  const files = [
    { id: "f1", members: ["me"] },
    { id: "f2", members: ["bob", "me"] },
    { id: "f3", members: ["bob", "lea", "me"] },
    { id: "f4", members: ["lea", "me"] },
  ];
  const { privateFile, shared } = matchFiles(files, "me");
  assert.equal(privateFile.id, "f1");
  assert.deepEqual([...shared].map(([key, f]) => [key, f.id]), [["bob", "f2"], ["bob+lea", "f3"], ["lea", "f4"]]);
  assert.equal(matchFiles([], "me").privateFile, undefined);
});

test("fileMembers: the user and the circle, sorted as the server sorts", () => {
  assert.deepEqual(fileMembers("m", ["z", "A", "b"]), ["A", "b", "m", "z"]);
  assert.deepEqual(fileMembers("me", []), ["me"]);
});

test("allKeyHolders: active devices of every member, recovery devices included, removed ones left out", () => {
  const mine = new Map([dev("a"), dev("r", "recovery"), dev("x", "device", false)]);
  const theirs = new Map([dev("b"), dev("s", "recovery")]);
  assert.deepEqual(allKeyHolders([mine, theirs]).map(d => d.id), ["a", "r", "b", "s"]);
});

test("hasContent: an empty circle left behind needs no file, one with notes or an order does", () => {
  assert.equal(hasContent(file()), false);
  assert.equal(hasContent(file(sample.notes[0])), true);
  assert.equal(hasContent({ ...file(), order: { ids: [], modified: "2026-10-13T09:00Z" } }), true);
});

test("limitRefusal: whose file limit refused an upload (backlog #27)", () => {
  const nameOf = id => ({ lea: "Lea", tom: "Tom" })[id] || "";
  assert.equal(limitRefusal(409, { detail: "version conflict" }, "me", nameOf), null);
  assert.equal(limitRefusal(413, { detail: "too many invitations" }, "me", nameOf), null);
  assert.deepEqual(limitRefusal(413, { detail: "storage quota exceeded" }, "me", nameOf), { own: true, kind: "storage" });
  assert.deepEqual(limitRefusal(413, { detail: "storage quota exceeded", members: ["lea", "me"] }, "me", nameOf), { own: true, kind: "storage" });
  assert.equal(limitRefusal(413, { detail: "storage quota exceeded", members: ["lea"] }, "me", nameOf).message,
    "The sync storage of Lea is full, so this shared note can't sync.");
  assert.equal(limitRefusal(413, { detail: "storage quota exceeded", members: ["lea", "tom", "x"] }, "me", nameOf).message,
    "The sync storage of Lea, Tom and a member is full, so this shared note can't sync.");
  assert.equal(limitRefusal(413, { detail: "too many files", members: ["x"] }, "me", nameOf).message,
    "A member has too many synced files, so this shared note can't sync.");
});


test("serverRestored: a new epoch means the server was restored", () => {
  assert.equal(serverRestored("abc", "xyz", []), true);
  assert.equal(serverRestored("abc", null, []), true);   // restored to before the first restore
  assert.equal(serverRestored("", "xyz", [{ seen: 3, served: 3 }]), true);   // the first restore, none remembered yet
  assert.equal(serverRestored(undefined, "xyz", []), true);
});

test("serverRestored: the same epoch and no older version is business as usual", () => {
  assert.equal(serverRestored("abc", "abc", [{ seen: 3, served: 3 }, { seen: 0, served: 7 }]), false);
  assert.equal(serverRestored("", null, []), false);   // never restored
  assert.equal(serverRestored(undefined, null, [{ seen: 2, served: 5 }]), false);
});

test("serverRestored: an older version than seen is a restore even without a new epoch", () => {
  assert.equal(serverRestored("abc", "abc", [{ seen: 3, served: 3 }, { seen: 4, served: 2 }]), true);
  assert.equal(serverRestored("", null, [{ seen: 1, served: 0 }]), true);
});

// Unit tests for the sync client's small decisions (app/js/core/sync-state.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNotesFile, createNote } from "../app/js/core/notes-file.js";
import { welcomeNotes, withoutUntouchedWelcome, matchFiles, fileMembers, allKeyHolders, hasContent, deviceRows, keyHolders, withDeviceName, storageUsage, limitRefusal, nextPollDelay, serverRestored, WELCOME_PREFIX, withSynced, dropSeenPurged, daysSince, blockedMessage, detachedFile, syncNotice } from "../app/js/core/sync-state.js";

const welcomeText = readFileSync(new URL("../app/welcome.md", import.meta.url), "utf8");
const sample = parseNotesFile(readFileSync(new URL("../app/sample/notes.md", import.meta.url), "utf8"));
const file = (...notes) => ({ preamble: "", notes, moved: [] });
const welcome = welcomeNotes(welcomeText, new Date("2026-10-13T08:00Z"));

test("welcomeNotes: one open note per top heading, newest first in the file's order", () => {
  assert.ok(welcome.length > 1);
  assert.ok(welcome.every(n => n.id.startsWith(WELCOME_PREFIX) && n.status === "open" && n.body.startsWith("## ")));
  assert.equal(welcome.map(n => n.body).join("\n\n"), welcomeText.trim());
  assert.equal(welcome[0].modified, "2026-10-13T08:00Z");
  assert.equal(welcome[1].modified, "2026-10-13T07:59Z");
  assert.equal(new Set(welcome.map(n => n.id)).size, welcome.length);
});

test("withoutUntouchedWelcome: drops unedited welcome notes, open or closed, and keeps the rest", () => {
  const [a, b, c] = welcome;
  const edited = { ...b, modified: "2026-10-13T09:00Z" };
  const closed = { ...c, status: "closed", closed: "2026-10-13T09:00Z" };
  assert.deepEqual(withoutUntouchedWelcome(file(a, edited, closed, sample.notes[0])).notes, [edited, sample.notes[0]]);
  assert.deepEqual(withoutUntouchedWelcome(file(...welcome)).notes, []);
  const own = file(sample.notes[0]);
  assert.equal(withoutUntouchedWelcome(own), own);
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
  const names = [{ id: "a", name: "Chrome on Windows", synced: "2026-10-14T08:00Z" }, { id: "b", name: "NoteDown app on Android" }, { id: "c", name: "Firefox on Linux" }];
  assert.deepEqual(deviceRows(devices, "b", names), [
    { id: "b", own: true, named: true, label: "NoteDown app on Android" },
    { id: "a", own: false, named: true, synced: "2026-10-14T08:00Z", label: "Chrome on Windows" },
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

test("withSynced: sets this device's sync time at most once a day and keeps its name", () => {
  const f = { ...file(), devices: [{ id: "d1", name: "Phone" }] };
  const once = withSynced(f, "d1", "2026-10-15T08:00Z");
  assert.deepEqual(once.devices, [{ id: "d1", name: "Phone", synced: "2026-10-15T08:00Z" }]);
  assert.equal(withSynced(once, "d1", "2026-10-15T20:00Z"), once, "same day: unchanged");
  assert.equal(withSynced(once, "d1", "2026-10-16T07:00Z").devices[0].synced, "2026-10-16T07:00Z");
  assert.deepEqual(withSynced(file(), "d2", "2026-10-15T08:00Z").devices, [{ id: "d2", synced: "2026-10-15T08:00Z" }], "a device without a name");
  assert.equal(withDeviceName(once, "d1", "Pixel").devices[0].synced, "2026-10-15T08:00Z", "renaming keeps the time");
});

test("dropSeenPurged: a purged marker goes once every active device synced after it", () => {
  const f = { ...file(), purged: [{ id: "a", purged: "2026-10-01T10:00Z" }, { id: "b", purged: "2026-10-10T10:00Z" }],
    devices: [{ id: "d1", synced: "2026-10-12T08:00Z" }, { id: "d2", synced: "2026-10-05T08:00Z" }, { id: "gone", synced: "2026-01-01T00:00Z" }] };
  assert.deepEqual(dropSeenPurged(f, ["d1", "d2"]).purged.map(m => m.id), ["b"], "d2 hasn't synced since b");
  assert.equal(dropSeenPurged(f, ["d1", "d2", "d3"]), f, "a device that never reported a time keeps them all");
  assert.deepEqual(dropSeenPurged(f, ["d1"]).purged, [], "a removed device doesn't count");
});

test("daysSince: whole days, undefined without a time", () => {
  assert.equal(daysSince("2026-10-01T12:00Z", Date.parse("2026-10-15T11:00Z")), 13);
  assert.equal(daysSince(undefined), undefined);
});

test("blockedMessage names the end of a block, if any", () => {
  assert.equal(blockedMessage(null), "Sync is blocked by the server's owner.");
  assert.equal(blockedMessage("2026-10-20T08:00:00+00:00", "UTC"), "Sync is blocked by the server's owner until 20 Oct 2026.");
});

test("detachedFile keeps every note as a private one and drops what belongs to the identity", () => {
  const own = createNote("## Own", "2026-10-01T09:00", "a");
  const trashed = { ...createNote("## Trashed", "2026-10-01T09:00", "b"), deleted: "2026-10-02T09:00", kept: "x" };
  const shared = createNote("## Shared", "2026-10-01T09:00", "c");
  const left = { ...createNote("## Left", "2026-10-01T09:00", "d"), left: ["me"] };
  const other = { ...createNote("## Left by another", "2026-10-01T09:00", "e"), left: ["x"] };
  const file = { preamble: "", notes: [own, trashed], moved: [{ id: "c", moved: "2026-10-01T10:00" }], purged: [{ id: "z", purged: "2026-10-01T10:00" }],
    devices: [{ id: "d1", name: "Phone" }], contacts: [{ id: "x", name: "Lea", color: 1 }], members: [], news: [{ id: "n", seen: "2026-10-01T10:00" }],
    order: { ids: ["a"], modified: "2026-10-01T10:00" } };
  const out = detachedFile(file, [{ members: ["x"], file: { notes: [shared, left, other] } }], "me");
  assert.deepEqual(out.notes.map(n => n.id), ["a", "b", "c", "e"]);
  assert.ok(out.notes.every(n => !("kept" in n) && !("left" in n)));
  assert.equal(out.notes[1].deleted, "2026-10-02T09:00");
  assert.deepEqual([out.moved, out.purged, out.devices, out.contacts], [[], [], [], []]);
  assert.deepEqual(out.news, file.news);
  assert.deepEqual(out.order, file.order);
});

test("syncNotice: removed and deleted while sync is off, blocked while it is on", () => {
  assert.equal(syncNotice({ enabled: true, ended: "", blocked: null }), null);
  assert.equal(syncNotice({ enabled: false, ended: "" }), null);
  assert.equal(syncNotice({ enabled: false, ended: "removed" }).kind, "removed");
  assert.equal(syncNotice({ enabled: false, ended: "deleted" }).closable, true);
  const blocked = syncNotice({ enabled: true, blocked: { until: "2026-10-25T00:00:00Z" } }, "UTC");
  assert.deepEqual([blocked.kind, blocked.title, blocked.closable], ["blocked", "Sync is blocked by the server's owner until 25 Oct 2026.", false]);
  assert.equal(syncNotice({ enabled: true, blocked: { until: null } }).title, "Sync is blocked by the server's owner.");
  assert.equal(syncNotice({ enabled: true, ended: "removed" }), null, "sync on again: no notice");
});

test("syncNotice: an outdated app is told to reload (web) or install the current app (Android)", () => {
  const web = syncNotice({ enabled: true, outdated: true, blocked: null });
  assert.deepEqual([web.kind, web.closable], ["outdated", false]);
  assert.match(web.sub, /Reload the page/);
  assert.match(syncNotice({ enabled: true, outdated: true }, undefined, true).sub, /Install the current app/);
  assert.equal(syncNotice({ enabled: true, outdated: true, blocked: { until: null } }).kind, "outdated", "updating comes first");
  assert.equal(syncNotice({ enabled: false, outdated: true }), null, "sync off: no notice");
});

test("keyVerdict: a new key only when a member's device signed it, never an older one", async () => {
  const { keyVerdict } = await import("../app/js/core/sync-state.js");
  const v = o => keyVerdict({ signed: true, trusted: true, gen: 2, known: 1, have: true, same: false, ...o });
  assert.equal(v({}), "take", "a renewal");
  assert.equal(v({ have: false, known: 0 }), "take", "a new device or file");
  assert.equal(v({ same: true, gen: 1, known: 1 }), "keep");
  assert.throws(() => v({ signed: false, trusted: false, gen: 0, same: true }), /isn't signed/, "an unsigned wrap, even of the key this device has");
  assert.throws(() => v({ signed: false, trusted: false, gen: 0 }), /isn't signed/, "the server's own key");
  assert.throws(() => v({ signed: false, trusted: false, gen: 0, have: false, known: 0 }), /isn't signed/);
  assert.throws(() => v({ trusted: false }), /isn't signed/, "signed by a device that isn't a member's");
  assert.throws(() => v({ gen: 1, known: 2 }), /outdated/, "an older key (a removed device knows it)");
  assert.throws(() => v({ gen: 2, known: 2 }), /outdated/, "another key of the same generation");
});

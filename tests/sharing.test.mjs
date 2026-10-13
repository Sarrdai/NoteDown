// Unit tests for the sync and sharing helpers (app/js/core/sharing.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNotesFile } from "../app/js/core/notes-file.js";
import {
  circleKey, circleLabel, shareState, initials, splitIntoCircles, generateRecoveryKey,
  normalizeRecoveryKey, inviteLink, contactId, uniqueName, syncedAgo, qrMatrix, QR_SIZE,
  colorIndex, nextColor, visibleMembers, circleGroups,
} from "../app/js/core/sharing.js";

const read = name => readFileSync(new URL("../app/sample/" + name, import.meta.url), "utf8");
const sample = parseNotesFile(read("notes.md"));
const sharing = JSON.parse(read("sharing.json"));

test("circleKey: sorted ids joined with +, empty for private", () => {
  assert.equal(circleKey([]), "");
  assert.equal(circleKey(["tom", "lea"]), "lea+tom");
  assert.equal(circleKey(["lea", "tom"]), circleKey(["tom", "lea"]));
});

test("circleLabel: names joined for one, two and more", () => {
  assert.equal(circleLabel([]), "");
  assert.equal(circleLabel(["Lea"]), "Lea");
  assert.equal(circleLabel(["Lea", "Tom"]), "Lea & Tom");
  assert.equal(circleLabel(["Lea", "Tom", "Grandma"]), "Lea, Tom & Grandma");
});

test("shareState: all, some or none of the selected notes", () => {
  assert.equal(shareState([["lea"], ["lea", "tom"]], "lea"), "all");
  assert.equal(shareState([["lea"], ["lea", "tom"]], "tom"), "some");
  assert.equal(shareState([[], ["lea"]], "tom"), "none");
  assert.equal(shareState([], "lea"), "none");
});

test("initials: first letters of the first two words", () => {
  assert.equal(initials("Lea"), "L");
  assert.equal(initials("Uncle Bob"), "UB");
  assert.equal(initials("  mary jane watson "), "MJ");
  assert.equal(initials(""), "");
});

test("sample sharing: every listed note exists exactly once and members are contacts", () => {
  const ids = sharing.shared.flatMap(g => g.notes);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.ok(sample.notes.some(n => n.id === id), id);
  const contacts = sharing.contacts.map(c => c.id);
  for (const g of sharing.shared) for (const m of g.members) assert.ok(contacts.includes(m), m);
});

test("splitIntoCircles: notes leave the private file without markers", () => {
  const { file, shared } = splitIntoCircles(sample, sharing.shared);
  assert.equal(shared.length, 2);
  assert.deepEqual(shared[0].members, ["lea"]);
  assert.deepEqual(shared[0].file.notes.map(n => n.id), ["s01", "s09"]);
  assert.deepEqual(shared[1].file.notes.map(n => n.id), ["s11"]);
  assert.equal(file.notes.length, sample.notes.length - 3);
  assert.ok(!file.notes.some(n => ["s01", "s09", "s11"].includes(n.id)));
  assert.deepEqual(file.moved, []);
});

test("splitIntoCircles: groups with the same member set share one file", () => {
  const { shared } = splitIntoCircles(sample, [
    { members: ["lea", "tom"], notes: ["s01"] },
    { members: ["tom", "lea"], notes: ["s02"] },
  ]);
  assert.equal(shared.length, 1);
  assert.deepEqual(shared[0].file.notes.map(n => n.id), ["s01", "s02"]);
});

test("recovery key: 6 groups of 4 from A–Z and 2–9, round-trips through normalize", () => {
  const key = generateRecoveryKey();
  assert.match(key, /^([A-Z2-9]{4}-){5}[A-Z2-9]{4}$/);
  assert.equal(normalizeRecoveryKey(key), key);
  assert.equal(normalizeRecoveryKey(key.toLowerCase().replaceAll("-", " ")), key);
  assert.equal(generateRecoveryKey(() => 0), "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA");
});

test("normalizeRecoveryKey: rejects wrong length and characters", () => {
  assert.equal(normalizeRecoveryKey(""), null);
  assert.equal(normalizeRecoveryKey("ABCD-EFGH"), null);
  assert.equal(normalizeRecoveryKey("ABCD-EFGH-JKLM-NPQR-STUV-WXY1"), null); // 1 is not in the alphabet
});

test("inviteLink: fixed prefix and a fragment", () => {
  assert.match(inviteLink(), /^https:\/\/notedown\.app\/c#[a-z0-9]{16}$/);
});

test("contactId and uniqueName stay unique", () => {
  assert.equal(contactId("Grandma", ["lea"]), "grandma");
  assert.equal(contactId("Grandma", ["grandma"]), "grandma-2");
  assert.equal(contactId("Zoë Müller", []), "zoe-muller");
  assert.equal(contactId("!!", []), "contact");
  assert.equal(uniqueName("New device", ["Pixel 8"]), "New device");
  assert.equal(uniqueName("New device", ["New device"]), "New device 2");
});

test("syncedAgo: minutes, hours, days", () => {
  const now = Date.UTC(2026, 9, 13, 12, 0);
  const ago = min => syncedAgo(now - min * 60000, now);
  assert.equal(ago(0), "just now");
  assert.equal(ago(1), "1 min ago");
  assert.equal(ago(42), "42 min ago");
  assert.equal(ago(60), "1 h ago");
  assert.equal(ago(5 * 60), "5 h ago");
  assert.equal(ago(24 * 60), "1 day ago");
  assert.equal(ago(3 * 24 * 60), "3 days ago");
});

test("qrMatrix: deterministic, finder squares in three corners, seed-dependent", () => {
  const a = qrMatrix("alex");
  assert.equal(a.length, QR_SIZE);
  assert.ok(a.every(row => row.length === QR_SIZE));
  assert.deepEqual(a, qrMatrix("alex"));
  assert.notDeepEqual(a, qrMatrix("lea"));
  for (const [ox, oy] of [[0, 0], [QR_SIZE - 7, 0], [0, QR_SIZE - 7]]) {
    assert.ok(a[oy][ox] && a[oy + 6][ox + 6] && a[oy + 3][ox + 3]);
    assert.ok(!a[oy + 1][ox + 1] && !a[oy + 1][ox + 5]);
  }
});

test("colorIndex: stable slot 1–6", () => {
  for (const k of ["lea", "tom", "lea+tom", "x"]) assert.ok(colorIndex(k) >= 1 && colorIndex(k) <= 6);
  assert.equal(colorIndex("lea"), colorIndex("lea"));
});

test("nextColor: the first free slot, wrapping when all six are used", () => {
  assert.equal(nextColor([]), 1);
  assert.equal(nextColor([{ color: 1 }, { color: 2 }]), 3);
  assert.equal(nextColor([{ color: 2 }]), 1);
  assert.equal(nextColor([1, 2, 3, 4, 5, 6].map(color => ({ color }))), 1);
});

test("visibleMembers: at most 3 shown, the rest counted", () => {
  assert.deepEqual(visibleMembers(["a", "b"]), { shown: ["a", "b"], more: 0 });
  assert.deepEqual(visibleMembers(["a", "b", "c", "d", "e"]), { shown: ["a", "b", "c"], more: 2 });
});

test("circleGroups: Private first, circles by label, order inside kept", () => {
  const { shared, file } = splitIntoCircles(sample, sharing.shared);
  const members = Object.fromEntries([[ "", file ], ...shared.map(s => [circleKey(s.members), s.file])].flatMap(([k, f]) => f.notes.map(n => [n.id, k ? k.split("+") : []])));
  const names = { lea: "Lea", tom: "Tom" };
  const all = [...shared[1].file.notes, ...file.notes.slice(0, 2), ...shared[0].file.notes];
  const groups = circleGroups(all, id => members[id], id => names[id]);
  assert.deepEqual(groups.map(g => g.label), ["Private", "Shared with Lea", "Shared with Lea & Tom"]);
  assert.deepEqual(groups[0].notes.map(n => n.id), file.notes.slice(0, 2).map(n => n.id));
  assert.deepEqual(groups[1].notes.map(n => n.id), ["s01", "s09"]);
  assert.deepEqual(circleGroups(file.notes.slice(0, 2), id => members[id], id => names[id]).map(g => g.label), ["Private"]);
  assert.deepEqual(circleGroups([shared[0].file.notes[0]], id => members[id], id => names[id]).map(g => g.label), ["Shared with Lea"]);
});

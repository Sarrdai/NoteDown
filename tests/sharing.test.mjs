// Unit tests for the sync and sharing helpers (app/js/core/sharing.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNotesFile } from "../app/js/core/notes-file.js";
import {
  circleKey, circleLabel, circleEntries, groupsWith, shareState, groupFull, initials, splitIntoCircles, generateRecoveryKey,
  normalizeRecoveryKey, inviteLink, contactId, uniqueName, syncedAgo,
  colorIndex, nextColor, visibleMembers, mergeCircle,
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
  // A member who isn't a contact has the name they wrote into the file (L1: a shared file from non-contacts is held back).
  const contacts = sharing.contacts.map(c => c.id);
  for (const g of sharing.shared) for (const m of g.members) assert.ok(contacts.includes(m) || g.names?.[m], m);
  // A shared order (backlog #25) only lists notes of its own circle.
  for (const g of sharing.shared.filter(g => g.order)) for (const id of g.order) assert.ok(g.notes.includes(id), id);
});

test("splitIntoCircles: notes leave the private file without markers", () => {
  const { file, shared } = splitIntoCircles(sample, sharing.shared);
  assert.equal(shared.length, 5);
  assert.deepEqual(shared[0].members, ["lea"]);
  assert.deepEqual(shared[0].file.notes.map(n => n.id), ["s01", "s09"]);
  assert.deepEqual(shared[1].file.notes.map(n => n.id), ["s18"]);
  assert.deepEqual(shared[2].members, ["trmnl"]);   // the display contact (backlog #49)
  assert.equal(file.notes.length, sample.notes.length - 6);
  assert.ok(!file.notes.some(n => ["s01", "s09", "s18", "s12"].includes(n.id)));
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

test("recovery key: 16 bytes as 26 base32 characters in groups, round-trips through normalize", () => {
  const key = generateRecoveryKey();
  assert.match(key, /^([A-Z2-7]{4}-){6}[A-Z2-7]{2}$/);
  assert.equal(normalizeRecoveryKey(key), key);
  assert.equal(normalizeRecoveryKey(key.toLowerCase().replaceAll("-", " ")), key);
  assert.equal(generateRecoveryKey(() => new Uint8Array(16)), "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AA");
  assert.equal(generateRecoveryKey(() => new Uint8Array(16).fill(255)), "7777-7777-7777-7777-7777-7777-74");
});

test("recovery key: RFC 4648 base32 of the bytes", () => {
  const bytes = Uint8Array.from("0f1e2d3c4b5a69788796a5b4c3d2e1f0".match(/../g), h => parseInt(h, 16));
  assert.equal(generateRecoveryKey(() => bytes), "B4PC-2PCL-LJUX-RB4W-UW2M-HUXB-6A");
});

test("normalizeRecoveryKey: maps the look-alikes 0 1 8 to O I B", () => {
  assert.equal(normalizeRecoveryKey("1OB0-8888-1111-0000-AAAA-AAAA-AA"), "IOBO-BBBB-IIII-OOOO-AAAA-AAAA-AA");
});

test("normalizeRecoveryKey: rejects wrong length, characters and set unused bits", () => {
  assert.equal(normalizeRecoveryKey(""), null);
  assert.equal(normalizeRecoveryKey("ABCD-EFGH"), null);
  assert.equal(normalizeRecoveryKey("AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAA"), null); // too long
  assert.equal(normalizeRecoveryKey("AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-A"), null); // too short
  assert.equal(normalizeRecoveryKey("AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-A9"), null); // 9 is not base32
  assert.equal(normalizeRecoveryKey("AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AB"), null); // unused bits set
  assert.equal(normalizeRecoveryKey("AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AE"), "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AE");
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

test("colorIndex: stable slot 1–6", () => {
  for (const k of ["lea", "tom", "x"]) assert.ok(colorIndex(k) >= 1 && colorIndex(k) <= 6);
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

test("mergeCircle: one circle stays, across circles a private copy or everyone involved", () => {
  assert.deepEqual(mergeCircle([["lea"], ["lea"]], "copy"), { members: ["lea"], keepShared: false });
  assert.deepEqual(mergeCircle([[], []], "share"), { members: [], keepShared: false });
  assert.deepEqual(mergeCircle([[], ["lea"], ["tom", "lea"]], "copy"), { members: [], keepShared: true });
  assert.deepEqual(mergeCircle([[], ["lea"], ["tom", "lea"]], "share"), { members: ["lea", "tom"], keepShared: false });
});

test("circleEntries: all, private, contacts A–Z (also without a file), then groups by label", () => {
  const contacts = [{ id: "tom", name: "Tom" }, { id: "lea", name: "Lea" }, { id: "sam", name: "Sam" }];
  const names = { tom: "Tom", lea: "Lea", sam: "Sam" };
  const entries = circleEntries(contacts, [["tom", "sam"], ["lea"], ["tom", "lea"]], id => names[id]);
  assert.deepEqual(entries.map(e => [e.key, e.kind]), [
    [null, "all"], ["", "private"], ["lea", "contact"], ["sam", "contact"], ["tom", "contact"],
    ["lea+tom", "group"], ["sam+tom", "group"],
  ]);
  assert.deepEqual(entries[5].members, ["lea", "tom"]);
});

test("groupsWith: circles of several people that contain the contact", () => {
  const circles = [["lea"], ["lea", "tom"], ["sam", "tom"]];
  assert.deepEqual(groupsWith("lea", circles), [["lea", "tom"]]);
  assert.deepEqual(groupsWith("sam", circles), [["sam", "tom"]]);
  assert.deepEqual(groupsWith("max", circles), []);
});

test("groupFull: a contact can't be added once a note's group would grow past the limit", () => {
  // Limit 3: the user and two contacts.
  assert.equal(groupFull([["lea"]], "tom", 3), false);
  assert.equal(groupFull([["lea", "tom"]], "sam", 3), true);
  assert.equal(groupFull([["lea", "tom"]], "lea", 3), false);            // already in: nothing grows
  assert.equal(groupFull([["lea"], ["lea", "tom"]], "sam", 3), true);   // one note is enough
  assert.equal(groupFull([["lea", "tom", "sam"]], "mia", 20), false);
  assert.equal(groupFull([["lea", "tom"]], "sam", null), false);         // no limit known yet
});

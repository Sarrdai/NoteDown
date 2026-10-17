// Unit tests for linking a device by QR code (app/js/core/linking.js) and the
// device names in the private file. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  linkCode, parseLinkCode, relayMessage, parseRelayMessage, deviceLabel, MAX_NAME, invitationLink, parseInvitationLink, contactCard, parseContactCard, serverUrl,
} from "../app/js/core/linking.js";
import { parseNotesFile, serializeNotesFile } from "../app/js/core/notes-file.js";
import { mergeNotesFiles } from "../app/js/core/merge.js";
import * as c from "../app/js/core/crypto.js";

const sample = parseNotesFile(readFileSync(new URL("../app/sample/notes.md", import.meta.url), "utf8"));
const slot = "AAAAAAAAAAAAAAAAAAAAAA";
const sign = "S".repeat(43), enc = "E".repeat(43), kem = "K".repeat(43);

test("link code: round-trips slot, keys and name; stays short enough for a phone camera", () => {
  const text = linkCode({ slot, sign, enc, kem, name: "Chrome on Windows", server: "" });
  assert.ok(text.startsWith("notedown:link?"));
  assert.ok(text.length < 250, text.length);   // the ML-KEM key itself waits at the slot, only its hash is here
  assert.deepEqual(parseLinkCode(text), { slot, sign, enc, kem, name: "Chrome on Windows", server: "" });
});

test("link code: anything else is rejected", () => {
  const good = linkCode({ slot, sign, enc, kem, name: "x" });
  assert.equal(parseLinkCode("https://example.org"), null);
  assert.equal(parseLinkCode(good.replace("v=1", "v=2")), null);
  assert.equal(parseLinkCode(good.replace(slot, "short")), null);
  assert.equal(parseLinkCode(good.replace(sign, "S".repeat(42))), null);
  assert.equal(parseLinkCode(good.replace("&kem=" + kem, "")), null);   // from before post-quantum keys
  assert.equal(parseLinkCode(null), null);
});

test("link code: the name is trimmed and capped", () => {
  const parsed = parseLinkCode(linkCode({ slot, sign, enc, kem, name: "  a\n b " + "x".repeat(60) }));
  assert.equal(parsed.name.length, MAX_NAME);
  assert.ok(parsed.name.startsWith("a b x"));
});

test("relay message: sealed for the new device's keys, unreadable for another", async () => {
  const newDevice = await c.generateDeviceKeys(), other = await c.generateDeviceKeys();
  const identity = "I".repeat(22);
  const payload = await c.sealRelayMessage(relayMessage(identity, "Sam"), c.recipientOf(newDevice));
  assert.deepEqual(parseRelayMessage(await c.openRelayMessage(payload, newDevice)), { identity, name: "Sam", server: "" });
  await assert.rejects(c.openRelayMessage(payload, other));
  // A wrapped file key is no relay message (separate HKDF labels).
  await assert.rejects(c.openRelayMessage(await c.wrapFileKey(c.generateFileKey(), c.recipientOf(newDevice)), newDevice));
  assert.equal(parseRelayMessage({ v: 1, identity: "bad" }), null);
});

test("deviceLabel: browser and system from the user agent; the Android app by its web view", () => {
  assert.equal(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"), "Chrome on Windows");
  assert.equal(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0"), "Edge on Windows");
  assert.equal(deviceLabel("Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0"), "Firefox on Linux");
  assert.equal(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"), "Safari on Mac");
  assert.equal(deviceLabel("Mozilla/5.0 (Linux; Android 14; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36"), "NoteDown app on Android");
  assert.equal(deviceLabel("Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36"), "Chrome on Android");
  assert.equal(deviceLabel(""), "Browser");
});

test("file format: device names round-trip after the notes and stay out of them", () => {
  const devices = [{ id: "AbC_-12345678901234567x", name: "Chrome on Windows (Büro)" }];
  const text = serializeNotesFile({ preamble: "", notes: [sample.notes[0]], moved: [], devices });
  assert.match(text, /<!-- device id=AbC_-12345678901234567x name=Chrome%20on%20Windows%20\(B%C3%BCro\) -->\n$/);
  const parsed = parseNotesFile(text);
  assert.deepEqual(parsed.devices, devices);
  assert.deepEqual(parsed.notes, [sample.notes[0]]);
});

test("merge: device names added on both sides are kept; a removal wins over no change", () => {
  const base = { ...parseNotesFile(""), devices: [{ id: "a", name: "A" }, { id: "b", name: "B" }] };
  const local = { ...base, devices: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }] };
  const remote = { ...base, devices: [{ id: "a", name: "A" }, { id: "d", name: "D" }] };
  const out = mergeNotesFiles(base, local, remote).file.devices;
  assert.deepEqual(out.map(d => d.id).sort(), ["a", "c", "d"]);
});

const identity = "A".repeat(22), secret = "B".repeat(22);

test("invitation link: round-trips identity, secret and name; short enough for a QR code", () => {
  const link = invitationLink({ web: "https://notedown.example.org/", identity, secret, name: "Lea Müller & Co" });
  assert.ok(link.startsWith("https://notedown.example.org/invite/#v=1&id="), link);
  assert.ok(link.length < 200, link.length);
  assert.deepEqual(parseInvitationLink(link), { identity, secret, name: "Lea Müller & Co", server: "" });
  assert.equal(parseInvitationLink(invitationLink({ web: "http://127.0.0.1:8766/app", identity, secret, name: "" })).name, "");
});

test("invitation link: read from pasted text with whitespace or a greeting around it; other text is refused", () => {
  const link = invitationLink({ web: "https://notedown.example.org", identity, secret, name: "Sam" });
  assert.equal(parseInvitationLink(`  \n${link}\t\n`).identity, identity);
  assert.equal(parseInvitationLink(`Join me on NoteDown: ${link} see you!`).secret, secret);
  assert.equal(parseInvitationLink("http://x.test/app/invite#v=1&id=" + identity + "&s=" + secret).identity, identity);   // without the slash
  assert.equal(parseInvitationLink("https://example.org"), null);
  assert.equal(parseInvitationLink("notedown:link?v=1&slot=x"), null);
  assert.equal(parseInvitationLink(link.replace("v=1", "v=2")), null);
  assert.equal(parseInvitationLink(link.replace(identity, "short")), null);
  assert.equal(parseInvitationLink(link.replace(secret, "B".repeat(21))), null);
  assert.equal(parseInvitationLink("https://example.org/page#v=1&id=" + identity + "&s=" + secret), null, "needs /invite");
  assert.equal(parseInvitationLink(null), null);
});

test("invitation link: the name is capped like a device name", () => {
  const link = invitationLink({ web: "https://x.test", identity, secret, name: "n".repeat(80) });
  assert.equal(parseInvitationLink(link).name.length, MAX_NAME);
});

test("contact card: build and parse with validation", () => {
  const card = contactCard(identity, "  Sam  ", secret);
  assert.deepEqual(card, { v: 1, identity, name: "Sam", secret });
  assert.deepEqual(parseContactCard(JSON.parse(JSON.stringify(card))), { identity, name: "Sam", secret });
  assert.equal(parseContactCard({ ...card, v: 2 }), null);
  assert.equal(parseContactCard({ ...card, identity: "x" }), null);
  assert.equal(parseContactCard({ ...card, secret: 5 }), null);
  assert.equal(parseContactCard(null), null);
  assert.equal(parseContactCard({ ...card, name: 7 }).name, "");
});

// ---------- servers (backlog #28) ----------

const S = "https://notes.example.org/api";

test("serverUrl: one written form, empty for none, null for anything but http(s)", () => {
  assert.equal(serverUrl("https://notes.example.org/api/"), S);
  assert.equal(serverUrl("http://127.0.0.1:8765"), "http://127.0.0.1:8765");
  assert.equal(serverUrl(""), "");
  assert.equal(serverUrl(undefined), "");
  assert.equal(serverUrl("ftp://x.test"), null);
  assert.equal(serverUrl("not a url"), null);
  assert.equal(serverUrl(5), null);
});

test("link code: carries the server the slot is on; missing reads as the default server", () => {
  const text = linkCode({ slot, sign, enc, kem, name: "x", server: S + "/" });
  assert.deepEqual(parseLinkCode(text), { slot, sign, enc, kem, name: "x", server: S });
  assert.equal(parseLinkCode(linkCode({ slot, sign, enc, kem, name: "x" })).server, "");
  assert.equal(parseLinkCode(text.replace(encodeURIComponent(S), "ftp%3A%2F%2Fx")), null);
});

test("relay message: carries the identity's home server; old messages read as the default server", () => {
  const identity = "A".repeat(22);
  assert.deepEqual(relayMessage(identity, "Sam", S), { v: 1, identity, name: "Sam", server: S });
  assert.deepEqual(parseRelayMessage(relayMessage(identity, "Sam", S)), { identity, name: "Sam", server: S });
  assert.deepEqual(parseRelayMessage({ v: 1, identity, name: "Sam" }), { identity, name: "Sam", server: "" });
  assert.equal("server" in relayMessage(identity, "Sam"), false);
  assert.equal(parseRelayMessage({ v: 1, identity, name: "Sam", server: "javascript:1" }), null);
});

test("invitation link: carries the inviter's home server; old links read as the default server", () => {
  const identity = "A".repeat(22), secret = "B".repeat(22);
  const link = invitationLink({ web: "https://notedown.example/app", identity, secret, name: "Lea", server: S });
  assert.deepEqual(parseInvitationLink(link), { identity, secret, name: "Lea", server: S });
  const old = `https://notedown.example/app/invite/#v=1&id=${identity}&s=${secret}&name=Lea`;
  assert.deepEqual(parseInvitationLink(old), { identity, secret, name: "Lea", server: "" });
  assert.equal(parseInvitationLink(old + "&srv=gopher%3A%2F%2Fx"), null);
});

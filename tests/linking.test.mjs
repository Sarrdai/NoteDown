// Unit tests for linking a device by QR code (app/js/core/linking.js) and the
// device names in the private file. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { linkCode, parseLinkCode, relayMessage, parseRelayMessage, deviceLabel, MAX_NAME } from "../app/js/core/linking.js";
import { parseNotesFile, serializeNotesFile } from "../app/js/core/notes-file.js";
import { mergeNotesFiles } from "../app/js/core/merge.js";
import * as c from "../app/js/core/crypto.js";

const sample = parseNotesFile(readFileSync(new URL("../app/sample/notes.md", import.meta.url), "utf8"));
const slot = "AAAAAAAAAAAAAAAAAAAAAA";
const sign = "S".repeat(43), enc = "E".repeat(43);

test("link code: round-trips slot, keys and name; stays short enough for a phone camera", () => {
  const text = linkCode({ slot, sign, enc, name: "Chrome on Windows" });
  assert.ok(text.startsWith("notedown:link?"));
  assert.ok(text.length < 200, text.length);
  assert.deepEqual(parseLinkCode(text), { slot, sign, enc, name: "Chrome on Windows" });
});

test("link code: anything else is rejected", () => {
  const good = linkCode({ slot, sign, enc, name: "x" });
  assert.equal(parseLinkCode("https://example.org"), null);
  assert.equal(parseLinkCode(good.replace("v=1", "v=2")), null);
  assert.equal(parseLinkCode(good.replace(slot, "short")), null);
  assert.equal(parseLinkCode(good.replace(sign, "S".repeat(42))), null);
  assert.equal(parseLinkCode(null), null);
});

test("link code: the name is trimmed and capped", () => {
  const parsed = parseLinkCode(linkCode({ slot, sign, enc, name: "  a\n b " + "x".repeat(60) }));
  assert.equal(parsed.name.length, MAX_NAME);
  assert.ok(parsed.name.startsWith("a b x"));
});

test("relay message: sealed for the new device's enc key, unreadable for another", async () => {
  const newDevice = await c.generateDeviceKeys(), other = await c.generateDeviceKeys();
  const identity = "I".repeat(22);
  const payload = await c.sealRelayMessage(relayMessage(identity, "Sam"), newDevice.enc.publicKey);
  assert.deepEqual(parseRelayMessage(await c.openRelayMessage(payload, newDevice.enc)), { identity, name: "Sam" });
  await assert.rejects(c.openRelayMessage(payload, other.enc));
  // A wrapped file key is no relay message (separate HKDF labels).
  await assert.rejects(c.openRelayMessage(await c.wrapFileKey(c.generateFileKey(), newDevice.enc.publicKey), newDevice.enc));
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

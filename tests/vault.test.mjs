// Unit tests for the encrypted local vault (app/js/core/vault.js, app/js/vault.js) and the update from a
// version that kept everything in plain localStorage (backlog #19). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeValue, decodeValue, sealRecord, openRecord, generateVaultKey, importVaultKey, migrateLegacy, legacyStorageKeys, isVaultable, secretName } from "../app/js/core/vault.js";

const notesText = readFileSync(new URL("../app/sample/notes.md", import.meta.url), "utf8");

test("values keep byte arrays through the record encoding", () => {
  const value = { text: "x", key: new Uint8Array([0, 1, 254, 255]), list: [new Uint8Array([7])] };
  const back = decodeValue(encodeValue(value));
  assert.ok(back.key instanceof Uint8Array && back.list[0] instanceof Uint8Array);
  assert.deepEqual([...back.key], [0, 1, 254, 255]);
  assert.equal(back.text, "x");
});

test("a record opens only with its key and its name, and hides its text", async () => {
  const key = await generateVaultKey();
  assert.equal(key.extractable, false);
  const sealed = await sealRecord(key, "notedown.file", notesText);
  const firstLine = notesText.split("\n").find(l => l.startsWith("## "));
  assert.ok(!new TextDecoder().decode(sealed).includes(firstLine), "no plain text in the record");
  assert.equal(await openRecord(key, "notedown.file", sealed), notesText);
  await assert.rejects(openRecord(key, "notedown.shared", sealed), "sealed for another name");
  await assert.rejects(openRecord(await generateVaultKey(), "notedown.file", sealed), "another key");
  const changed = sealed.slice();
  changed[changed.length - 1] ^= 1;
  await assert.rejects(openRecord(key, "notedown.file", changed), "a changed record");
});

test("the Android data key is imported non-extractable and its bytes are wiped", async () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = await importVaultKey(bytes);
  assert.equal(key.extractable, false);
  assert.ok(bytes.every(b => b === 0));
});

test("only plain data goes into the vault; CryptoKeys stay where they are", async () => {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  assert.equal(isVaultable(new Uint8Array(32)), true);
  assert.equal(isVaultable({ a: "b" }), true);
  assert.equal(isVaultable({ sign: pair }), false);
});

test("the old localStorage keys move, the server address stays", () => {
  assert.deepEqual(legacyStorageKeys(["notedown.file", "notedown.api", "other", "notedown.settings"]).map(k => k.name), ["notedown.file", "notedown.settings"]);
  assert.equal(secretName("file:srv/f1"), "secret:file:srv/f1");
});

// A vault over a Map, with an optional fault.
function mapVault({ changeOnRead = false } = {}) {
  const m = new Map();
  return {
    m,
    get: async n => (m.has(n) ? (changeOnRead ? m.get(n) + "!" : m.get(n)) : undefined),
    put: async (n, v) => { m.set(n, v); },
  };
}
function legacyOf(entries) {
  const items = new Map(entries);
  return {
    items: async () => [...items].map(([name, value]) => ({ name, value })),
    remove: async names => names.forEach(n => items.delete(n)),
    left: () => [...items.keys()],
  };
}

test("migration moves everything, checks it reads back and only then removes the plain copy", async () => {
  const fileKey = new Uint8Array([9, 8, 7]);
  const legacy = legacyOf([["notedown.file", notesText], ["secret:file:/f1", fileKey]]);
  const vault = mapVault();
  const r = await migrateLegacy(legacy, vault);
  assert.deepEqual(r.moved, ["notedown.file", "secret:file:/f1"]);
  assert.equal(vault.m.get("notedown.file"), notesText);
  assert.deepEqual([...vault.m.get("secret:file:/f1")], [9, 8, 7]);
  assert.deepEqual(legacy.left(), []);
});

test("migration keeps the plain copy when the vault reads back something else", async () => {
  const legacy = legacyOf([["notedown.file", notesText]]);
  await assert.rejects(migrateLegacy(legacy, mapVault({ changeOnRead: true })), /reads back changed/);
  assert.deepEqual(legacy.left(), ["notedown.file"], "nothing removed");
});

test("an interrupted migration finishes on the next start without overwriting newer vault data", async () => {
  const legacy = legacyOf([["notedown.file", "old"], ["notedown.settings", "{}"]]);
  const vault = mapVault();
  await vault.put("notedown.file", "newer");   // written by this version after an earlier, interrupted run
  const r = await migrateLegacy(legacy, vault);
  assert.deepEqual(r.moved, ["notedown.settings"]);
  assert.equal(vault.m.get("notedown.file"), "newer");
  assert.deepEqual(legacy.left(), []);
});

test("updating from plain localStorage: the store loads the same notes, the vault holds them, localStorage is emptied", async () => {
  // The state an older version left behind; like the browser's, its own keys are the stored items.
  class FakeStorage {
    getItem(k) { return Object.hasOwn(this, k) ? this[k] : null; }
    setItem(k, v) { this[k] = String(v); }
    removeItem(k) { delete this[k]; }
  }
  globalThis.localStorage = Object.assign(new FakeStorage(), {
    "notedown.file": notesText,
    "notedown.settings": JSON.stringify({ flavor: "mocha" }),
    "notedown.sync": JSON.stringify({ enabled: false }),
    "notedown.api": "http://127.0.0.1:8765",
  });
  try {
    const { load, state, fileText } = await import("../app/js/store.js");
    const { openVault } = await import("../app/js/vault.js");
    assert.equal(await load(), true, "the stored file is found");
    assert.equal(fileText(), notesText, "the notes are unchanged");
    assert.equal(state.settings.flavor, "mocha");
    assert.deepEqual(Object.keys(localStorage), ["notedown.api"], "only the server address stays in plain text");
    assert.equal(await (await openVault()).get("notedown.file"), notesText);
  } finally {
    delete globalThis.localStorage;
  }
});

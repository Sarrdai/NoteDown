// Unit tests for the encrypted local vault (app/js/core/vault.js, app/js/vault.js; backlog #19). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeValue, decodeValue, sealRecord, openRecord, generateVaultKey, importVaultKey, secretName } from "../app/js/core/vault.js";

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

test("the store keeps its files in the vault and reads them back", async () => {
  const { load, replaceFiles, fileText, flushStored } = await import("../app/js/store.js");
  const { openVault } = await import("../app/js/vault.js");
  const { parseNotesFile } = await import("../app/js/core/notes-file.js");
  await load();
  replaceFiles({ file: parseNotesFile(notesText) });
  await flushStored();
  const stored = fileText();
  assert.equal(await (await openVault()).get("notedown.file"), stored);
  assert.equal(await load(), true, "load reads the file from the vault");
  assert.equal(fileText(), stored);
  assert.equal(secretName("file:srv/f1"), "secret:file:srv/f1");
});

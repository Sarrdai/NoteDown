// Unit tests for the sync cryptography (app/js/core/crypto.js), pinned to the
// server by tests/fixtures/crypto-vectors.json (scripts/crypto-vectors.py). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  b64u, fromB64u, canonicalJson, keyId, entryHash, recoveryKeyBytes, deriveRecovery, generateDeviceKeys,
  deviceRecord, newEntry, signEntry, verifyChain, authMessage, signChallenge, generateFileKey, encryptFile,
  decryptFile, wrapFileKey, unwrapFileKey, importSigningSeed, importEncSeed, MAX_DEVICES,
  newInvitationSecret, invitationId, invitationMessage, signInvitation, verifyInvitation, sealContactCard, openContactCard,
} from "../app/js/core/crypto.js";

const vectors = JSON.parse(readFileSync(new URL("./fixtures/crypto-vectors.json", import.meta.url), "utf8"));
const hex = text => Uint8Array.from(text.match(/../g), h => parseInt(h, 16));
const toHex = bytes => Buffer.from(bytes).toString("hex");
const text = bytes => new TextDecoder().decode(bytes);
const clone = value => structuredClone(value);

async function deviceFrom(v) {
  return { sign: await importSigningSeed(hex(v.sign_seed)), enc: await importEncSeed(hex(v.enc_seed)) };
}

// A fresh chain built the way the client does: phone, recovery device, then `more`.
async function freshChain() {
  const rec = await deriveRecovery(recoveryKeyBytes(vectors.recovery.text));
  const identityId = await keyId(rec.identity.publicKey);
  const phone = await generateDeviceKeys();
  const phoneRecord = await deviceRecord(phone, "device");
  const chain = { identityKey: rec.identity.publicKey, identityId, rec, phone, phoneRecord, entries: [] };
  chain.append = async (op, device, signer, key) => {
    const entry = await signEntry(await newEntry(identityId, chain.entries, op, device), signer, key);
    chain.entries.push(entry);
    return entry;
  };
  await chain.append("add", phoneRecord, "identity", rec.identity.privateKey);
  await chain.append("add", await deviceRecord(rec.recovery, "recovery"), "identity", rec.identity.privateKey);
  return chain;
}

const rejects = (promise, message) => assert.rejects(promise, { message });

test("b64u / fromB64u: round trip, canonical form and length only", () => {
  const bytes = Uint8Array.from([0xfb, 0xff, 0xfe, 1, 2]);
  assert.equal(b64u(bytes), "-__-AQI");
  assert.deepEqual(fromB64u("-__-AQI"), bytes);
  assert.equal(b64u(new Uint8Array(0)), "");
  assert.equal(fromB64u("-__-AQI", 5).length, 5);
  assert.throws(() => fromB64u("-__-AQI", 4), /expected 4 bytes/);
  assert.throws(() => fromB64u("-__-AQJ"), /non-canonical base64url/); // unused bits set
  assert.throws(() => fromB64u("-__-AQI="), /invalid base64url/);
  assert.throws(() => fromB64u("a"), /invalid base64url/);
  assert.throws(() => fromB64u("ab+/"), /invalid base64url/);
  assert.throws(() => fromB64u(5), /invalid base64url/);
  const big = new Uint8Array(100000).fill(7);
  assert.deepEqual(fromB64u(b64u(big)), big);
});

test("canonicalJson: identical to Python for every vector case", () => {
  for (const c of vectors.canonical) assert.equal(toHex(canonicalJson(c.value)), c.bytes, JSON.stringify(c.value));
});

test("canonicalJson: keys by code point, not UTF-16 unit; rejects floats", () => {
  assert.equal(text(canonicalJson({ "\u{1f600}": 1, "": 2 })), '{"":2,"\u{1f600}":1}');
  assert.throws(() => canonicalJson({ a: 1.5 }), /unsupported type/);
  assert.throws(() => canonicalJson({ a: undefined }), /unsupported type/);
  assert.throws(() => canonicalJson("\ud800"), /lone surrogate/);
});

test("recovery key: bytes, identity and recovery device keys match Python", async () => {
  const bytes = recoveryKeyBytes(vectors.recovery.text);
  assert.equal(toHex(bytes), vectors.recovery.bytes);
  assert.equal(toHex(recoveryKeyBytes(vectors.recovery.text.toLowerCase().replaceAll("-", " "))), vectors.recovery.bytes);
  assert.equal(recoveryKeyBytes("nonsense"), null);
  const { identity, recovery } = await deriveRecovery(bytes);
  assert.equal(b64u(identity.publicKey), vectors.recovery.identity_sign);
  assert.equal(await keyId(identity.publicKey), vectors.recovery.identity_id);
  assert.equal(b64u(recovery.sign.publicKey), vectors.recovery.device.sign);
  assert.equal(b64u(recovery.enc.publicKey), vectors.recovery.device.enc);
  assert.equal(await keyId(recovery.sign.publicKey), vectors.recovery.device.id);
});

test("derived private keys are not extractable", async () => {
  const { identity, recovery } = await deriveRecovery(recoveryKeyBytes(vectors.recovery.text));
  const device = await generateDeviceKeys();
  for (const pair of [identity, recovery.sign, recovery.enc, device.sign, device.enc]) {
    assert.equal(pair.privateKey.extractable, false);
    assert.equal(pair.publicKey.length, 32);
    await assert.rejects(crypto.subtle.exportKey("pkcs8", pair.privateKey));
  }
});

test("device keys from the vector seeds have Python's public keys and IDs", async () => {
  const phone = await deviceFrom(vectors.phone);
  assert.equal(b64u(phone.sign.publicKey), vectors.phone.sign);
  assert.equal(b64u(phone.enc.publicKey), vectors.phone.enc);
  assert.equal(await keyId(phone.sign.publicKey), vectors.phone.id);
  assert.deepEqual(await deviceRecord(phone, "device"), vectors.chain[0].device);
});

test("generateDeviceKeys: fresh pairs, record has the ID of the signing key", async () => {
  const a = await generateDeviceKeys(), b = await generateDeviceKeys();
  assert.notDeepEqual(a.sign.publicKey, b.sign.publicKey);
  const record = await deviceRecord(a, "device");
  assert.deepEqual(Object.keys(record), ["id", "kind", "sign", "enc"]);
  assert.equal(record.id, await keyId(a.sign.publicKey));
});

test("chain: JS rebuilds the Python entries byte for byte (deterministic signatures)", async () => {
  const rec = await deriveRecovery(recoveryKeyBytes(vectors.recovery.text));
  const phone = await deviceFrom(vectors.phone), tablet = await deviceFrom(vectors.tablet);
  const recoveryDevice = await deviceFrom(vectors.recovery.device);
  const id = vectors.recovery.identity_id;
  const entries = [];
  const add = async (op, device, signer, key) => entries.push(await signEntry(await newEntry(id, entries, op, device), signer, key));
  await add("add", await deviceRecord(phone, "device"), "identity", rec.identity.privateKey);
  await add("add", await deviceRecord(recoveryDevice, "recovery"), "identity", rec.identity.privateKey);
  await add("add", await deviceRecord(tablet, "device"), vectors.phone.id, phone.sign.privateKey);
  await add("remove", { id: vectors.tablet.id }, vectors.tablet.id, tablet.sign.privateKey);
  assert.deepEqual(entries, vectors.chain);
  for (const [i, e] of vectors.chain.entries()) assert.equal(await entryHash(e), vectors.chain_hashes[i]);
});

test("verifyChain: accepts the Python chain and reports every device", async () => {
  const devices = await verifyChain(fromB64u(vectors.recovery.identity_sign), vectors.chain);
  assert.deepEqual([...devices.keys()], [vectors.phone.id, vectors.recovery.device.id, vectors.tablet.id]);
  assert.deepEqual([...devices.values()].map(d => d.active), [true, true, false]);
  assert.deepEqual([...devices.values()].map(d => d.kind), ["device", "recovery", "device"]);
  const phone = devices.get(vectors.phone.id);
  assert.equal(b64u(phone.sign), vectors.phone.sign);
  assert.equal(b64u(phone.enc), vectors.phone.enc);
  assert.equal((await verifyChain(fromB64u(vectors.recovery.identity_sign), [])).size, 0);
});

test("verifyChain: rejects tampered Python chains with the server's messages", async () => {
  const key = fromB64u(vectors.recovery.identity_sign);
  const tamper = (fn) => { const c = clone(vectors.chain); fn(c); return c; };

  await rejects(verifyChain(key, tamper(c => { c[2].device.kind = "recovery"; })), "entry 2: bad signature");
  await rejects(verifyChain(key, tamper(c => { c[1].sig = c[0].sig; })), "entry 1: bad signature");
  await rejects(verifyChain(key, tamper(c => { c[1].prev = c[0].prev; })), "entry 1: prev does not match");
  await rejects(verifyChain(key, tamper(c => { c[0].seq = 1; })), "entry 0: wrong identity or seq");
  await rejects(verifyChain(key, tamper(c => { c[0].identity = vectors.phone.id; })), "entry 0: wrong identity or seq");
  await rejects(verifyChain(key, tamper(c => { delete c[0].sig; })), "entry 0: malformed");
  await rejects(verifyChain(key, tamper(c => { c[0].extra = "x"; })), "entry 0: malformed");
  await rejects(verifyChain(key, tamper(c => { c[0].seq = "0"; })), "entry 0: malformed");
  await rejects(verifyChain(key, tamper(c => { c[3].signer = "nobody"; })), "entry 3: signer is not on the list");
  await rejects(verifyChain(key, tamper(c => { c[0].sig = "AAAA"; })), "expected 64 bytes");
  await rejects(verifyChain(key, tamper(c => { c[0].sig = "!" + c[0].sig.slice(1); })), "invalid base64url");
  await rejects(verifyChain(fromB64u(vectors.phone.sign), vectors.chain), "entry 0: wrong identity or seq");
});

test("verifyChain: a removed device can't sign any more", async () => {
  const chain = await freshChain();
  const tablet = await generateDeviceKeys();
  const tabletRecord = await deviceRecord(tablet, "device");
  await chain.append("add", tabletRecord, chain.phoneRecord.id, chain.phone.sign.privateKey);
  await chain.append("remove", { id: tabletRecord.id }, chain.phoneRecord.id, chain.phone.sign.privateKey);
  await verifyChain(chain.identityKey, chain.entries);
  await chain.append("remove", { id: chain.phoneRecord.id }, tabletRecord.id, tablet.sign.privateKey);
  await rejects(verifyChain(chain.identityKey, chain.entries), "entry 4: signer is not on the list");
});

test("verifyChain: a device removes itself, and the identity can remove too", async () => {
  const chain = await freshChain();
  const tablet = await generateDeviceKeys();
  const record = await deviceRecord(tablet, "device");
  await chain.append("add", record, "identity", chain.rec.identity.privateKey);
  await chain.append("remove", { id: record.id }, record.id, tablet.sign.privateKey);
  await chain.append("remove", { id: chain.phoneRecord.id }, "identity", chain.rec.identity.privateKey);
  const devices = await verifyChain(chain.identityKey, chain.entries);
  assert.deepEqual([...devices.values()].map(d => d.active), [false, true, false]);
});

test("verifyChain: the recovery device can't be removed and there is only one", async () => {
  const chain = await freshChain();
  const recoveryId = chain.entries[1].device.id;
  const removal = await signEntry(await newEntry(chain.identityId, chain.entries, "remove", { id: recoveryId }), "identity", chain.rec.identity.privateKey);
  await rejects(verifyChain(chain.identityKey, [...chain.entries, removal]), "entry 2: device can't be removed");

  const second = await deviceRecord(await generateDeviceKeys(), "recovery");
  const add = await signEntry(await newEntry(chain.identityId, chain.entries, "add", second), "identity", chain.rec.identity.privateKey);
  await rejects(verifyChain(chain.identityKey, [...chain.entries, add]), "entry 2: second recovery device");
});

test("verifyChain: rejects a reused ID, a wrong ID, an unknown kind or op, malformed devices", async () => {
  const chain = await freshChain();
  const sign = body => signEntry(body, "identity", chain.rec.identity.privateKey);
  const next = (op, device) => newEntry(chain.identityId, chain.entries, op, device);
  const check = async (op, device, message) => rejects(verifyChain(chain.identityKey, [...chain.entries, await sign(await next(op, device))]), message);

  await check("add", chain.phoneRecord, "entry 2: wrong or reused device id");
  const other = await deviceRecord(await generateDeviceKeys(), "device");
  await check("add", { ...other, id: chain.phoneRecord.id.replace(/^./, "A") }, "entry 2: wrong or reused device id");
  await check("add", { ...other, kind: "phone" }, "entry 2: unknown kind");
  await check("add", { id: other.id }, "entry 2: malformed device");
  await check("add", { ...other, enc: "!" + other.enc.slice(1) }, "invalid base64url");
  await check("add", { ...other, sign: b64u(new Uint8Array(31)) }, "expected 32 bytes");
  await check("rename", other, "entry 2: unknown op");
  await check("remove", { id: "short" }, "entry 2: malformed remove");
  await check("remove", { id: other.id, kind: "device" }, "entry 2: malformed remove");
  await check("remove", { id: other.id }, "entry 2: device can't be removed");
});

test("verifyChain: at most 20 active devices", async () => {
  const chain = await freshChain();
  for (let i = 0; i < MAX_DEVICES - 2; i++) {
    await chain.append("add", await deviceRecord(await generateDeviceKeys(), "device"), "identity", chain.rec.identity.privateKey);
  }
  assert.equal((await verifyChain(chain.identityKey, chain.entries)).size, MAX_DEVICES);
  const extra = await deviceRecord(await generateDeviceKeys(), "device");
  const entry = await signEntry(await newEntry(chain.identityId, chain.entries, "add", extra), "identity", chain.rec.identity.privateKey);
  await rejects(verifyChain(chain.identityKey, [...chain.entries, entry]), `entry ${MAX_DEVICES}: too many devices`);
});

test("auth: message and signature match Python", async () => {
  assert.equal(text(authMessage(vectors.auth.challenge)), vectors.auth.message);
  const phone = await deviceFrom(vectors.phone);
  assert.equal(await signChallenge(phone.sign.privateKey, vectors.auth.challenge), vectors.auth.signature);
});

test("file: decrypts the Python ciphertext, round trips, fresh nonce each time", async () => {
  const key = hex(vectors.file.key);
  assert.equal(await decryptFile(key, vectors.file.ciphertext), vectors.file.text);
  const a = await encryptFile(key, vectors.file.text), b = await encryptFile(key, vectors.file.text);
  assert.notEqual(a, b);
  assert.notEqual(fromB64u(a).subarray(0, 12).join(), fromB64u(b).subarray(0, 12).join());
  assert.equal(await decryptFile(key, a), vectors.file.text);
  assert.equal(await decryptFile(key, await encryptFile(key, "")), "");
  assert.equal(fromB64u(a).length, 12 + 4096 + 16);
  assert.equal(fromB64u(vectors.file.ciphertext).length, 12 + 4096 + 16);
});

test("file: an unpadded ciphertext from before padding still decrypts", async () => {
  const key = hex(vectors.legacy_file.key);
  const legacy = fromB64u(vectors.legacy_file.ciphertext);
  assert.equal(legacy.length, 12 + new TextEncoder().encode(vectors.legacy_file.text).length + 16);
  assert.equal(await decryptFile(key, vectors.legacy_file.ciphertext), vectors.legacy_file.text);
});

// The AES-GCM plaintext of an encryptFile result, to look at the padding itself.
async function plaintextOf(key, ciphertext) {
  const raw = fromB64u(ciphertext);
  const aes = await globalThis.crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(await globalThis.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: raw.subarray(0, 12) }, aes, raw.subarray(12)));
}

test("file: padding is 0x80 then zeros up to the next multiple of 4096 bytes", async () => {
  const key = generateFileKey();
  const cases = [
    ["", 4096], ["a", 4096], ["a".repeat(4094), 4096], ["a".repeat(4095), 4096],
    ["a".repeat(4096), 8192], ["a".repeat(8191), 8192], ["a".repeat(8192), 12288],
  ];
  for (const [text, size] of cases) {
    const ciphertext = await encryptFile(key, text);
    const plain = await plaintextOf(key, ciphertext);
    assert.equal(fromB64u(ciphertext).length, 12 + size + 16, `${text.length} bytes`);
    assert.equal(plain.length, size);
    const used = new TextEncoder().encode(text).length;
    assert.equal(plain[used], 0x80);
    assert.ok(plain.subarray(used + 1).every(b => b === 0));
    assert.equal(await decryptFile(key, ciphertext), text);
  }
});

test("file: texts ending in a multi-byte character or in a 0x80 byte round trip", async () => {
  const key = generateFileKey();
  // " " is E2 80 80: it ends in the marker byte itself.
  for (const text of ["Zoë\n", "ends in an emoji \u{1f600}", "ends in 0x80  ", "a".repeat(4094) + "ä", " ".repeat(1366)]) {
    assert.equal(await decryptFile(key, await encryptFile(key, text)), text);
  }
});

test("file: wrong key or changed data is rejected", async () => {
  const key = hex(vectors.file.key);
  await assert.rejects(decryptFile(generateFileKey(), vectors.file.ciphertext));
  const raw = fromB64u(vectors.file.ciphertext);
  raw[20] ^= 1;
  await assert.rejects(decryptFile(key, b64u(raw)));
});

test("file key: unwraps the Python wrapped key; JS wrap round trips; fits the limit", async () => {
  const phone = await deviceFrom(vectors.phone);
  assert.equal(toHex(await unwrapFileKey(vectors.wrap.wrapped, phone.enc)), vectors.wrap.file_key);

  const key = generateFileKey();
  assert.equal(key.length, 32);
  const wrapped = await wrapFileKey(key, phone.enc.publicKey);
  assert.ok(wrapped.length <= 512);
  assert.equal(fromB64u(wrapped).length, 32 + 12 + 32 + 16);
  assert.deepEqual(await unwrapFileKey(wrapped, phone.enc), key);
  assert.notEqual(wrapped, await wrapFileKey(key, phone.enc.publicKey));

  const other = await generateDeviceKeys();
  await assert.rejects(unwrapFileKey(wrapped, other.enc));
});

test("invitation: ID, message and signature match Python", async () => {
  const v = vectors.invite;
  assert.equal(await invitationId(fromB64u(v.secret, 16)), v.id);
  assert.equal(text(invitationMessage(v.id)), v.message);
  const phone = await deviceFrom(vectors.phone);
  assert.equal(await signInvitation(phone.sign.privateKey, v.id), v.signature); // Ed25519 is deterministic
  assert.equal(await verifyInvitation(phone.sign.publicKey, v.signature, v.id), true);
});

test("invitation: a fresh secret has 16 bytes and its own ID; a wrong key, ID or signature fails", async () => {
  const secret = newInvitationSecret();
  assert.equal(secret.length, 16);
  assert.notDeepEqual(secret, newInvitationSecret());
  const id = await invitationId(secret);
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  const device = await generateDeviceKeys(), other = await generateDeviceKeys();
  const sig = await signInvitation(device.sign.privateKey, id);
  assert.equal(await verifyInvitation(device.sign.publicKey, sig, id), true);
  assert.equal(await verifyInvitation(other.sign.publicKey, sig, id), false);
  assert.equal(await verifyInvitation(device.sign.publicKey, sig, await invitationId(newInvitationSecret())), false);
  assert.equal(await verifyInvitation(device.sign.publicKey, "not-base64!", id), false);
  assert.equal(await verifyInvitation(device.sign.publicKey, sig.slice(0, 40), id), false);
});

test("contact card: opens Python's sealed card; JS seal round trips, fits the limit and is no wrapped key", async () => {
  const phone = await deviceFrom(vectors.phone);
  const v = vectors.contact_card;
  assert.deepEqual(await openContactCard(v.sealed, phone.enc), v.card);
  const card = { v: 1, identity: "I".repeat(22), name: "Zoë ".repeat(10).trim(), secret: "S".repeat(22) };
  const sealed = await sealContactCard(card, phone.enc.publicKey);
  assert.ok(sealed.length <= 512, sealed.length);
  assert.deepEqual(await openContactCard(sealed, phone.enc), card);
  assert.notEqual(sealed, await sealContactCard(card, phone.enc.publicKey));
  const other = await generateDeviceKeys();
  await assert.rejects(openContactCard(sealed, other.enc));
  // Separate HKDF labels: a card is no relay payload and no wrapped key, and the other way round.
  await assert.rejects(openContactCard(await wrapFileKey(generateFileKey(), phone.enc.publicKey), phone.enc));
  await assert.rejects(unwrapFileKey(sealed, phone.enc));
});

test("safetyCode: the same for both sides, 5 groups of 4 digits, different per pair", async () => {
  const { safetyCode } = await import("../app/js/core/crypto.js");
  const a = "TGVhSWRlbnRpdHkxMjM0NQ", b = "VG9tSWRlbnRpdHkxMjM0NTY", c = "U2FtSWRlbnRpdHkxMjM0NTY";
  const ab = await safetyCode(a, b);
  assert.equal(ab, "0236 6534 4560 2936 6818");   // pinned: both phones must keep computing the same code
  assert.equal(await safetyCode(b, a), ab);
  assert.notEqual(await safetyCode(a, c), ab);
  assert.equal(await safetyCode(a, b), ab);
});

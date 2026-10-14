// Client-side cryptography of sync (docs/server-api.md): encodings, keys, the
// signed device list, authentication and file encryption. WebCrypto only, no
// DOM; byte-compatible with server/notedown_server/protocol.py (pinned by
// tests/fixtures/crypto-vectors.json).
import { normalizeRecoveryKey } from "./sharing.js";

const subtle = () => globalThis.crypto.subtle;
const utf8 = text => new TextEncoder().encode(text);
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

export const MAX_DEVICES = 20;
const NONCE_BYTES = 12;

/** A request or chain that breaks the protocol (the server answers 400). */
export class ProtocolError extends Error {}

// ---------- encodings ----------

/** Base64url without padding. */
export function b64u(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Strict base64url decoding (canonical form only); throws unless `length` bytes when given. */
export function fromB64u(text, length) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
    throw new ProtocolError("invalid base64url");
  }
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
  if (b64u(bytes) !== text) throw new ProtocolError("non-canonical base64url");
  if (length !== undefined && bytes.length !== length) throw new ProtocolError(`expected ${length} bytes`);
  return bytes;
}

/** Orders strings by code point (Python's `sort_keys`), not by UTF-16 unit. */
function byCodePoint(a, b) {
  const x = Array.from(a, c => c.codePointAt(0)), y = Array.from(b, c => c.codePointAt(0));
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

function canonicalText(value) {
  if (typeof value === "string") {
    if (value.isWellFormed && !value.isWellFormed()) throw new ProtocolError("lone surrogate in a string");
    return JSON.stringify(value);
  }
  if (Number.isSafeInteger(value) || typeof value === "bigint") return String(value);
  if (value === null || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalText).join(",") + "]";
  if (typeof value === "object" && !(value instanceof Uint8Array)) {
    return "{" + Object.keys(value).sort(byCodePoint).map(k => canonicalText(k) + ":" + canonicalText(value[k])).join(",") + "}";
  }
  throw new ProtocolError("unsupported type in canonical JSON");
}

/** Canonical JSON as UTF-8 bytes: sorted keys, no whitespace, only strings, integers and objects (plus arrays, booleans, null). */
export function canonicalJson(value) {
  return utf8(canonicalText(value));
}

async function sha256(bytes) {
  return new Uint8Array(await subtle().digest("SHA-256", bytes));
}

/** ID of a public signing key: b64u of the first 16 bytes of its SHA-256 (identity and device IDs). */
export async function keyId(publicKeyBytes) {
  return b64u((await sha256(publicKeyBytes)).subarray(0, 16));
}

/** `prev` of the next entry: b64u of the SHA-256 of the entry's canonical JSON (including `sig`). */
export async function entryHash(entry) {
  return b64u(await sha256(canonicalJson(entry)));
}

// ---------- keys ----------

const SEED_PREFIX = { // fixed PKCS#8 header of a 32-byte raw private key
  Ed25519: "302e020100300506032b657004220420",
  X25519: "302e020100300506032b656e04220420",
};
const USAGES = { Ed25519: ["sign"], X25519: ["deriveBits"] };

async function importSeed(name, seed) {
  if (seed.length !== 32) throw new ProtocolError("expected a 32-byte seed");
  const header = Uint8Array.from(SEED_PREFIX[name].match(/../g), h => parseInt(h, 16));
  const pkcs8 = concat(header, seed);
  const exportable = await subtle().importKey("pkcs8", pkcs8, { name }, true, USAGES[name]);
  const publicKey = fromB64u((await subtle().exportKey("jwk", exportable)).x, 32);
  const privateKey = await subtle().importKey("pkcs8", pkcs8, { name }, false, USAGES[name]);
  return { privateKey, publicKey };
}

/** For tests and restore: Ed25519 key pair from a 32-byte seed (private key non-extractable). */
export function importSigningSeed(seed) {
  return importSeed("Ed25519", seed);
}

/** For tests and restore: X25519 key pair from a 32-byte seed (private key non-extractable). */
export function importEncSeed(seed) {
  return importSeed("X25519", seed);
}

async function hkdf(ikm, salt, info, length = 32) {
  const key = await subtle().importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** The 16 recovery key bytes of a typed recovery key, or null when it is not valid. */
export function recoveryKeyBytes(text) {
  const key = normalizeRecoveryKey(text);
  if (!key) return null;
  const bytes = [];
  let bits = 0, value = 0;
  for (const c of key.replaceAll("-", "")) {
    value = (value << 5) | BASE32.indexOf(c);
    bits += 5;
    if (bits >= 8) { bytes.push((value >> (bits - 8)) & 255); bits -= 8; value &= (1 << bits) - 1; }
  }
  return Uint8Array.from(bytes);
}

/** The identity key pair and the recovery device's key pairs (`{ identity, recovery: { sign, enc } }`) from the recovery key bytes. */
export async function deriveRecovery(recoveryBytes) {
  const seed = info => hkdf(recoveryBytes, utf8("NoteDown"), utf8(info));
  const [identity, sign, enc] = await Promise.all([
    seed("identity-sign").then(importSigningSeed),
    seed("recovery-sign").then(importSigningSeed),
    seed("recovery-enc").then(importEncSeed),
  ]);
  return { identity, recovery: { sign, enc } };
}

async function generatePair(name) {
  const { privateKey, publicKey } = await subtle().generateKey({ name }, false, USAGES[name].concat(name === "Ed25519" ? ["verify"] : []));
  return { privateKey, publicKey: new Uint8Array(await subtle().exportKey("raw", publicKey)) };
}

/** New device keys: Ed25519 `sign` and X25519 `enc` pairs, private keys non-extractable, public keys raw bytes. */
export async function generateDeviceKeys() {
  const [sign, enc] = await Promise.all([generatePair("Ed25519"), generatePair("X25519")]);
  return { sign, enc };
}

/** A device-list record `{ id, kind, sign, enc }` ("device" or "recovery") for the keys. */
export async function deviceRecord(keys, kind) {
  return { id: await keyId(keys.sign.publicKey), kind, sign: b64u(keys.sign.publicKey), enc: b64u(keys.enc.publicKey) };
}

// ---------- device list ----------

/** The unsigned next entry of the chain: correct `seq` and `prev`; `device` is the full record or `{ id }`. */
export async function newEntry(identityId, entries, op, device) {
  const prev = entries.length ? await entryHash(entries[entries.length - 1]) : "";
  return { identity: identityId, seq: entries.length, prev, op, device };
}

/** Signs an entry body; `signer` is "identity" or the signing device's ID. */
export async function signEntry(body, signer, privateKey) {
  const unsigned = { ...body, signer };
  const sig = await subtle().sign({ name: "Ed25519" }, privateKey, canonicalJson(unsigned));
  return { ...unsigned, sig: b64u(new Uint8Array(sig)) };
}

async function verifySignature(publicKey, signature, message) {
  try {
    const key = await subtle().importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    return await subtle().verify({ name: "Ed25519" }, key, signature, message);
  } catch {
    return false;
  }
}

const ENTRY_KEYS = ["device", "identity", "op", "prev", "seq", "sig", "signer"];
const isObject = v => typeof v === "object" && v !== null && !Array.isArray(v);
const sameKeys = (obj, keys) => Object.keys(obj).sort().join() === keys.join();
const isId = text => typeof text === "string" && /^[A-Za-z0-9_-]{22}$/.test(text);

/**
 * Checks a whole device list like the server; returns a Map of every device
 * ever added by ID: `{ id, kind, sign, enc (raw bytes), active }`.
 */
export async function verifyChain(identityKeyBytes, entries) {
  const identity = await keyId(identityKeyBytes);
  const devices = new Map();
  for (const [seq, entry] of entries.entries()) {
    const fail = message => new ProtocolError(`entry ${seq}: ${message}`);
    if (!isObject(entry) || !sameKeys(entry, ENTRY_KEYS) || !Number.isInteger(entry.seq)
        || !["identity", "prev", "op", "signer", "sig"].every(k => typeof entry[k] === "string")) throw fail("malformed");
    if (entry.identity !== identity || entry.seq !== seq) throw fail("wrong identity or seq");
    if (entry.prev !== (seq ? await entryHash(entries[seq - 1]) : "")) throw fail("prev does not match");

    const signer = entry.signer === "identity" ? { sign: identityKeyBytes }
      : devices.get(entry.signer)?.active ? devices.get(entry.signer) : null;
    if (!signer) throw fail("signer is not on the list");
    const { sig, ...unsigned } = entry;
    if (!await verifySignature(signer.sign, fromB64u(sig, 64), canonicalJson(unsigned))) throw fail("bad signature");

    if (entry.op === "add") await applyAdd(entry.device, devices, fail);
    else if (entry.op === "remove") applyRemove(entry.device, devices, fail);
    else throw fail("unknown op");
  }
  return devices;
}

async function applyAdd(device, devices, fail) {
  if (!isObject(device) || !sameKeys(device, ["enc", "id", "kind", "sign"])
      || !Object.values(device).every(v => typeof v === "string")) throw fail("malformed device");
  const sign = fromB64u(device.sign, 32), enc = fromB64u(device.enc, 32);
  if (device.id !== await keyId(sign) || devices.has(device.id)) throw fail("wrong or reused device id");
  if (!["device", "recovery"].includes(device.kind)) throw fail("unknown kind");
  const all = [...devices.values()];
  if (device.kind === "recovery" && all.some(d => d.kind === "recovery")) throw fail("second recovery device");
  if (all.filter(d => d.active).length >= MAX_DEVICES) throw fail("too many devices");
  devices.set(device.id, { id: device.id, kind: device.kind, sign, enc, active: true });
}

function applyRemove(device, devices, fail) {
  if (!isObject(device) || !sameKeys(device, ["id"]) || !isId(device.id)) throw fail("malformed remove");
  const target = devices.get(device.id);
  if (!target || !target.active || target.kind === "recovery") throw fail("device can't be removed");
  target.active = false;
}

// ---------- authentication ----------

/** The bytes a device signs to authenticate: `notedown-auth-v1:<challenge>`. */
export function authMessage(challenge) {
  return utf8(`notedown-auth-v1:${challenge}`);
}

/** b64u Ed25519 signature of the auth message, for `POST /v1/auth/token`. */
export async function signChallenge(privateKey, challenge) {
  return b64u(new Uint8Array(await subtle().sign({ name: "Ed25519" }, privateKey, authMessage(challenge))));
}

// ---------- files ----------

const aesKey = (bytes, usage) => subtle().importKey("raw", bytes, "AES-GCM", false, [usage]);

async function seal(keyBytes, plain) {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = await subtle().encrypt({ name: "AES-GCM", iv: nonce }, await aesKey(keyBytes, "encrypt"), plain);
  return { nonce, sealed: new Uint8Array(sealed) };
}

async function open(keyBytes, nonce, sealed) {
  return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: nonce }, await aesKey(keyBytes, "decrypt"), sealed));
}

/** A new random AES-256 file key (32 bytes). */
export function generateFileKey() {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

const PAD_BLOCK = 4096;
const PAD_MARKER = 0x80;

// ISO/IEC 7816-4 padding: a 0x80 byte, then 0x00 up to the next multiple of PAD_BLOCK (a plaintext
// that already is a multiple gets a full extra block), so the server only sees the size in 4 KiB steps.
function pad(bytes) {
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / PAD_BLOCK) * PAD_BLOCK);
  padded.set(bytes);
  padded[bytes.length] = PAD_MARKER;
  return padded;
}

function unpad(bytes) {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  // No marker: a file uploaded before padding existed. Those are Markdown that ends with "\n",
  // never with 0x00 or 0x80, so they can't be mistaken for padded ones; the next upload pads them.
  return end > 0 && bytes[end - 1] === PAD_MARKER ? bytes.subarray(0, end - 1) : bytes;
}

/** b64u of nonce (12 bytes, fresh each call) ‖ AES-256-GCM of the padded UTF-8 text. */
export async function encryptFile(fileKey, text) {
  const { nonce, sealed } = await seal(fileKey, pad(utf8(text)));
  return b64u(concat(nonce, sealed));
}

/** The text of `encryptFile`'s output (or of an older, unpadded file); throws when the key is wrong or the data was changed. */
export async function decryptFile(fileKey, ciphertext) {
  const raw = fromB64u(ciphertext);
  const plain = await open(fileKey, raw.subarray(0, NONCE_BYTES), raw.subarray(NONCE_BYTES));
  return new TextDecoder("utf-8", { fatal: true }).decode(unpad(plain));
}

async function wrapKey(label, privateKey, otherPublic, ephemeralPublic, recipientPublic) {
  const other = await subtle().importKey("raw", otherPublic, { name: "X25519" }, false, []);
  const shared = new Uint8Array(await subtle().deriveBits({ name: "X25519", public: other }, privateKey, 256));
  return hkdf(shared, new Uint8Array(0), concat(utf8(label), ephemeralPublic, recipientPublic));
}

// Ephemeral X25519 to the recipient's `enc` key, HKDF with `label`, AES-GCM:
// b64u of ephemeral public key ‖ nonce ‖ ciphertext.
async function sealFor(label, recipientEncPublic, plain) {
  const ephemeral = await generatePair("X25519");
  const key = await wrapKey(label, ephemeral.privateKey, recipientEncPublic, ephemeral.publicKey, recipientEncPublic);
  const { nonce, sealed } = await seal(key, plain);
  return b64u(concat(ephemeral.publicKey, nonce, sealed));
}

async function openFor(label, text, encKeyPair) {
  const raw = fromB64u(text);
  const ephemeralPublic = raw.subarray(0, 32);
  const key = await wrapKey(label, encKeyPair.privateKey, ephemeralPublic, ephemeralPublic, encKeyPair.publicKey);
  return open(key, raw.subarray(32, 32 + NONCE_BYTES), raw.subarray(32 + NONCE_BYTES));
}

/** b64u of ephemeral X25519 public key ‖ nonce ‖ AES-GCM(wrap key, file key), for the recipient's `enc` key. */
export function wrapFileKey(fileKey, recipientEncPublic) {
  return sealFor("notedown-wrap", recipientEncPublic, fileKey);
}

/** The 32-byte file key from `wrapFileKey`'s output; `encKeyPair` is `{ privateKey, publicKey }`. */
export function unwrapFileKey(wrapped, encKeyPair) {
  return openFor("notedown-wrap", wrapped, encKeyPair);
}

/** The relay payload for a new device: `message` (JSON-able) sealed like a file key, label `notedown-relay`. */
export function sealRelayMessage(message, recipientEncPublic) {
  return sealFor("notedown-relay", recipientEncPublic, utf8(JSON.stringify(message)));
}

/** The message of `sealRelayMessage`'s output; throws when it wasn't sealed for `encKeyPair`. */
export async function openRelayMessage(payload, encKeyPair) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await openFor("notedown-relay", payload, encKeyPair)));
}

// ---------- contacts and invitations (docs/server-api.md → "Contacts and invitations") ----------

const SECRET_BYTES = 16;

/** A new invitation secret: 16 random bytes. */
export function newInvitationSecret() {
  return globalThis.crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
}

/** The invitation ID of a secret: b64u of the first 16 bytes of its SHA-256. */
export async function invitationId(secretBytes) {
  return b64u((await sha256(secretBytes)).subarray(0, 16));
}

/** What the inviting device signs: `notedown-invite-v1:<invitation id>`. */
export function invitationMessage(id) {
  return utf8(`notedown-invite-v1:${id}`);
}

/** b64u Ed25519 signature of the invitation message, for `POST /v1/invitations`. */
export async function signInvitation(privateKey, id) {
  return b64u(new Uint8Array(await subtle().sign({ name: "Ed25519" }, privateKey, invitationMessage(id))));
}

/** Whether `sig` (b64u) is the signature of the device with public signing key `signKey` over invitation `id`. */
export async function verifyInvitation(signKey, sig, id) {
  try {
    return await verifySignature(signKey, fromB64u(sig, 64), invitationMessage(id));
  } catch {
    return false;
  }
}

/** A contact request's card (JSON-able) sealed like a relay payload for a device's `enc` key, label `notedown-contact`. */
export function sealContactCard(card, recipientEncPublic) {
  return sealFor("notedown-contact", recipientEncPublic, utf8(JSON.stringify(card)));
}

/** The card of `sealContactCard`'s output; throws when it wasn't sealed for `encKeyPair`. */
export async function openContactCard(sealed, encKeyPair) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await openFor("notedown-contact", sealed, encKeyPair)));
}

// ---------- safety codes (docs/sync-and-sharing.md → "Contacts") ----------

const SAFETY_ITERATIONS = 100000;
const SAFETY_GROUPS = 5;

/**
 * The safety code of two identities, the same on both phones: 20 digits in groups of four, from
 * PBKDF2-SHA256 over both identity IDs in sorted order. 66 bits and the slow hash make a forged contact
 * whose code matches too costly to find (someone in the middle needs two identities with equal codes).
 */
export async function safetyCode(identityA, identityB) {
  const pair = [identityA, identityB].sort(byCodePoint).join(":");
  const key = await subtle().importKey("raw", utf8(pair), "PBKDF2", false, ["deriveBits"]);
  const bits = new DataView(await subtle().deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: utf8("notedown-safety-code-v1"), iterations: SAFETY_ITERATIONS }, key, 32 * SAFETY_GROUPS));
  return Array.from({ length: SAFETY_GROUPS }, (_, i) => String(bits.getUint32(4 * i) % 10000).padStart(4, "0")).join(" ");
}

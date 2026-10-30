// Client-side cryptography of sync (docs/server-api.md): encodings, keys, the
// signed device list and its pins, authentication and file encryption. WebCrypto plus
// ML-KEM-768 (app/vendor/mlkem.js, libcrux as WebAssembly), no DOM;
// byte-compatible with server/notedown_server/protocol.py and
// scripts/crypto-vectors.py (pinned by tests/fixtures/crypto-vectors.json).
import { normalizeRecoveryKey } from "./sharing.js";
import { mlkemPublicKey, mlkemEncapsulate, mlkemDecapsulate } from "../../vendor/mlkem.js";

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
const KEM_SEED_BYTES = 64;      // ML-KEM-768 seed d ‖ z (FIPS 203)
const KEM_PUBLIC_BYTES = 1184;  // ML-KEM-768 encapsulation key
const KEM_CT_BYTES = 1088;      // ML-KEM-768 ciphertext

/** A request or chain that breaks the protocol (the server answers 400). */
export class ProtocolError extends Error {}

/**
 * The longest text of a file, in bytes of UTF-8 (docs/server-api.md → "Limits"). A few MB of DEFLATE inflate to
 * gigabytes, so a member of a shared file could crash the others' apps: every client and the TRMNL plugin refuse
 * more (`server/notedown_server/protocol.py`, security review M4).
 */
export const MAX_TEXT_BYTES = 16 * 1024 * 1024;

/** A file's text over `MAX_TEXT_BYTES`: refused when opening a file and when sealing one. */
export class TextTooLargeError extends ProtocolError {
  constructor() {
    super(`a file's text is larger than ${MAX_TEXT_BYTES / 2 ** 20} MiB`);
  }
}

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

/** Ed25519 key pair from a 32-byte seed (private key non-extractable). */
export function importSigningSeed(seed) {
  return importSeed("Ed25519", seed);
}

/** X25519 key pair from a 32-byte seed (private key non-extractable). */
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

/** For tests and restore: ML-KEM-768 key pair `{ seed, publicKey }` from a 64-byte seed (the seed is the private key). */
export async function importKemSeed(seed) {
  if (seed.length !== KEM_SEED_BYTES) throw new ProtocolError("expected a 64-byte seed");
  return { seed, publicKey: await mlkemPublicKey(seed) };
}

/** The identity key pair and the recovery device's key pairs (`{ identity, recovery: { sign, enc, kem } }`) from the recovery key bytes. */
export async function deriveRecovery(recoveryBytes) {
  const seed = (info, length) => hkdf(recoveryBytes, utf8("NoteDown"), utf8(info), length);
  const [identity, sign, enc, kem] = await Promise.all([
    seed("identity-sign").then(importSigningSeed),
    seed("recovery-sign").then(importSigningSeed),
    seed("recovery-enc").then(importEncSeed),
    seed("recovery-kem", KEM_SEED_BYTES).then(importKemSeed),
  ]);
  return { identity, recovery: { sign, enc, kem } };
}

// A fresh pair (the ephemeral X25519 key of a seal).
async function generatePair(name) {
  const { privateKey, publicKey } = await subtle().generateKey({ name }, false, USAGES[name].concat(name === "Ed25519" ? ["verify"] : []));
  return { privateKey, publicKey: new Uint8Array(await subtle().exportKey("raw", publicKey)) };
}

/**
 * Device keys from their seeds (docs/sync-and-sharing.md → "Where the files live"): Ed25519 `sign` and X25519
 * `enc` pairs (private keys non-extractable, public keys raw bytes), the ML-KEM-768 `kem` pair `{ seed, publicKey }`
 * and the `seeds` themselves (`{ sign, enc, kem }`), which the encrypted vault keeps.
 */
export async function deviceKeysFromSeeds(seeds) {
  const [sign, enc, kem] = await Promise.all([importSigningSeed(seeds.sign), importEncSeed(seeds.enc), importKemSeed(seeds.kem)]);
  return { sign, enc, kem, seeds };
}

/** New device keys from random seeds (as `deviceKeysFromSeeds`). */
export function generateDeviceKeys() {
  const random = length => globalThis.crypto.getRandomValues(new Uint8Array(length));
  return deviceKeysFromSeeds({ sign: random(32), enc: random(32), kem: random(KEM_SEED_BYTES) });
}

/** A device-list record `{ id, kind, sign, enc, kem }` ("device" or "recovery") for the keys (records of devices
 *  added before post-quantum wrapping, still in old device lists, have no `kem`). */
export async function deviceRecord(keys, kind) {
  return {
    id: await keyId(keys.sign.publicKey), kind, sign: b64u(keys.sign.publicKey), enc: b64u(keys.enc.publicKey),
    ...(keys.kem && { kem: b64u(keys.kem.publicKey) }),
  };
}

/** What a key is wrapped for: a device's public `{ enc, kem }` (raw bytes), from its keys. */
export function recipientOf(keys) {
  return { enc: keys.enc.publicKey, kem: keys.kem.publicKey };
}

/** The commitment to an ML-KEM public key in a link code: b64u of its SHA-256. */
export async function kemHash(publicKey) {
  return b64u(await sha256(publicKey));
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
 * ever added by ID: `{ id, kind, sign, enc, kem (raw bytes, kem null until the device has one), active, signedOut }`;
 * `signedOut`: the device removed itself (signing out), so its signatures from before still count.
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
    else if (entry.op === "remove") applyRemove(entry.device, entry.signer, devices, fail);
    else if (entry.op === "kem") applyKem(entry.device, entry.signer, devices, fail);
    else throw fail("unknown op");
  }
  return devices;
}

async function applyAdd(device, devices, fail) {
  if (!isObject(device) || !(sameKeys(device, ["enc", "id", "kind", "sign"]) || sameKeys(device, ["enc", "id", "kem", "kind", "sign"]))
      || !Object.values(device).every(v => typeof v === "string")) throw fail("malformed device");
  const sign = fromB64u(device.sign, 32), enc = fromB64u(device.enc, 32);
  const kem = device.kem === undefined ? null : fromB64u(device.kem, KEM_PUBLIC_BYTES);
  if (device.id !== await keyId(sign) || devices.has(device.id)) throw fail("wrong or reused device id");
  if (!["device", "recovery"].includes(device.kind)) throw fail("unknown kind");
  const all = [...devices.values()];
  if (device.kind === "recovery" && all.some(d => d.kind === "recovery")) throw fail("second recovery device");
  if (all.filter(d => d.active).length >= MAX_DEVICES) throw fail("too many devices");
  devices.set(device.id, { id: device.id, kind: device.kind, sign, enc, kem, active: true, signedOut: false });
}

// A device that was added without an ML-KEM key gets one: signed by itself, or by the identity (the recovery device).
function applyKem(device, signer, devices, fail) {
  if (!isObject(device) || !sameKeys(device, ["id", "kem"]) || !isId(device.id) || typeof device.kem !== "string") throw fail("malformed kem");
  const target = devices.get(device.id);
  if (!target || !target.active || target.kem) throw fail("device can't get a kem key");
  if (signer !== device.id && signer !== "identity") throw fail("kem must be signed by the device itself");
  target.kem = fromB64u(device.kem, KEM_PUBLIC_BYTES);
}

function applyRemove(device, signer, devices, fail) {
  if (!isObject(device) || !sameKeys(device, ["id"]) || !isId(device.id)) throw fail("malformed remove");
  const target = devices.get(device.id);
  if (!target || !target.active || target.kind === "recovery") throw fail("device can't be removed");
  target.active = false;
  target.signedOut = signer === device.id;
}

/** What a device remembers of a verified device list: its length and the hash of its last entry. */
export async function chainPin(entries) {
  return { n: entries.length, head: entries.length ? await entryHash(entries[entries.length - 1]) : "" };
}

/**
 * Throws unless `entries` go on from the list `pin` describes (`chainPin`; none: nothing seen yet): at least as
 * long, with the same entry where the pinned list ended. A device list only grows, so a server can't hand out an
 * older one, in which a removed device is active again (security review H3).
 */
export async function checkPin(pin, entries) {
  if (!pin || !pin.n) return;
  if (entries.length < pin.n) throw new ProtocolError("the device list is shorter than one this device has seen");
  if (await entryHash(entries[pin.n - 1]) !== pin.head) throw new ProtocolError("the device list differs from one this device has seen");
}

// ---------- authentication ----------

/**
 * The bytes a device signs to authenticate: canonical JSON naming the server (`server`, the host the app calls
 * it at), the identity, the device and the challenge — so a server the device talked to, which passed on another
 * server's challenge, gets no sign-in there (security review H1).
 */
export function authMessage({ server, identity, device, challenge }) {
  return canonicalJson({ label: "notedown-auth-v2", server, identity, device, challenge });
}

/** b64u Ed25519 signature of the auth message (`statement`: `{ server, identity, device, challenge }`), for `POST /v1/auth/token`. */
export async function signChallenge(privateKey, statement) {
  return b64u(new Uint8Array(await subtle().sign({ name: "Ed25519" }, privateKey, authMessage(statement))));
}

/** What the identity key signs to delete the identity: canonical JSON naming the server, the identity and the challenge. */
export function deletionMessage({ server, identity, challenge }) {
  return canonicalJson({ label: "notedown-delete-v2", server, identity, challenge });
}

/** The identity key's signature that deletes the identity (docs/server-api.md → "Blocked and deleted identities"). */
export async function signDeletion(identityPrivateKey, statement) {
  return b64u(new Uint8Array(await subtle().sign({ name: "Ed25519" }, identityPrivateKey, deletionMessage(statement))));
}

// ---------- files ----------

const aesKey = (bytes, usage) => subtle().importKey("raw", bytes, "AES-GCM", false, [usage]);

// `aad`: additional authenticated data (a file's binding, the previous key of the key chain).
async function seal(keyBytes, plain, aad) {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const params = aad ? { name: "AES-GCM", iv: nonce, additionalData: aad } : { name: "AES-GCM", iv: nonce };
  const sealed = await subtle().encrypt(params, await aesKey(keyBytes, "encrypt"), plain);
  return { nonce, sealed: new Uint8Array(sealed) };
}

async function open(keyBytes, nonce, sealed, aad) {
  const params = aad ? { name: "AES-GCM", iv: nonce, additionalData: aad } : { name: "AES-GCM", iv: nonce };
  return new Uint8Array(await subtle().decrypt(params, await aesKey(keyBytes, "decrypt"), sealed));
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

// The first byte of a compressed file's plaintext: 0x01, then the raw DEFLATE stream (RFC 1951) of the UTF-8
// text. Markdown never starts with 0x01, so files from before compression are read as plain UTF-8.
const COMPRESSED = 0x01;

async function through(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

const INFLATE_SLICE = 16 * 1024;

// The raw DEFLATE stream `bytes` inflated, cancelled with a TextTooLargeError as soon as its output passes MAX_TEXT_BYTES.
// DEFLATE inflates up to 1032 times over, and a browser inflates the whole chunk it is given before anything can count
// it (Chromium: a 1 MB chunk of a bomb is 1 GB), so the stream goes in slices of 16 KiB: at most about 16 MB are
// inflated past the limit.
async function inflate(bytes) {
  let at = 0;
  const slices = new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      const end = Math.min(at + INFLATE_SLICE, bytes.length);
      controller.enqueue(bytes.subarray(at, end));
      at = end;
    },
  });
  const reader = slices.pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_TEXT_BYTES) {
      await reader.cancel().catch(() => {});
      throw new TextTooLargeError();
    }
    parts.push(value);
  }
  return new Uint8Array(await new Blob(parts).arrayBuffer());
}

// The associated data that binds a file's ciphertext to the file and the version it is uploaded as (`{ file, version }`,
// the version the upload creates: base_version + 1), so a server can't hand out an older state as a newer version or
// one file's state as another's (security review H2).
function fileBinding({ file, version } = {}) {
  if (!isId(file) || !Number.isSafeInteger(version) || version < 1) throw new ProtocolError("a file is bound to its file and version");
  return canonicalJson({ label: "notedown-file", file, version });
}

/**
 * b64u of nonce (12 bytes, fresh each call) ‖ AES-256-GCM of the padded 0x01 ‖ DEFLATE of the UTF-8 text, the file ID
 * and the version it is uploaded as (`binding`: `{ file, version }`) as associated data. A text of more than
 * MAX_TEXT_BYTES of UTF-8 is refused (TextTooLargeError), so no file is uploaded that the others can't open.
 */
export async function encryptFile(fileKey, text, binding) {
  const aad = fileBinding(binding);
  const bytes = utf8(text);
  if (bytes.length > MAX_TEXT_BYTES) throw new TextTooLargeError();
  const packed = concat(Uint8Array.of(COMPRESSED), await through(bytes, new CompressionStream("deflate-raw")));
  const { nonce, sealed } = await seal(fileKey, pad(packed), aad);
  return b64u(concat(nonce, sealed));
}

async function openFile(fileKey, ciphertext, aad) {
  const raw = fromB64u(ciphertext);
  const body = unpad(await open(fileKey, raw.subarray(0, NONCE_BYTES), raw.subarray(NONCE_BYTES), aad));
  const bytes = body[0] === COMPRESSED ? await inflate(body.subarray(1)) : body;
  if (bytes.length > MAX_TEXT_BYTES) throw new TextTooLargeError();   // an uncompressed body; `inflate` stops by itself
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** The text of `encryptFile`'s output for that file and version (`binding`); throws when the key, the file or the version is another or the data was changed, and TextTooLargeError for a text over MAX_TEXT_BYTES. */
export async function decryptFile(fileKey, ciphertext, binding) {
  return openFile(fileKey, ciphertext, fileBinding(binding));
}

/** The text of a file uploaded before files were bound to their version (no associated data; also uncompressed or unpadded ones). */
export async function decryptLegacyFile(fileKey, ciphertext) {
  return openFile(fileKey, ciphertext);
}

const PREVIOUS_KEY = utf8("notedown-previous-key");

/** The key chain of the version history: b64u of nonce ‖ AES-GCM(new file key, old file key), associated data `notedown-previous-key`. */
export async function sealPreviousKey(newKey, oldKey) {
  const { nonce, sealed } = await seal(newKey, oldKey, PREVIOUS_KEY);
  return b64u(concat(nonce, sealed));
}

/** The old file key from `sealPreviousKey`'s output; throws when `newKey` is the wrong one. */
export function openPreviousKey(newKey, text) {
  const raw = fromB64u(text);
  return open(newKey, raw.subarray(0, NONCE_BYTES), raw.subarray(NONCE_BYTES), PREVIOUS_KEY);
}

async function x25519(privateKey, otherPublic) {
  const other = await subtle().importKey("raw", otherPublic, { name: "X25519" }, false, []);
  return new Uint8Array(await subtle().deriveBits({ name: "X25519", public: other }, privateKey, 256));
}

const HYBRID = 0x01;   // first byte of a hybrid (post-quantum) sealed value
const HYBRID_HEAD = 1 + 32 + KEM_CT_BYTES;

// The wrap key of a hybrid seal: HKDF-SHA256 over both shared secrets, info the label and the SHA-256 of both
// ciphertexts and both public keys (as PQXDH, plus the KEM transcript; hashed because WebCrypto implementations
// cap info at 1024 bytes), so it holds if either X25519 or ML-KEM-768 does.
async function hybridKey(label, sharedX, sharedKem, ephemeralPublic, recipient, kemCiphertext) {
  const transcript = await sha256(concat(ephemeralPublic, recipient.enc, kemCiphertext, recipient.kem));
  return hkdf(concat(sharedX, sharedKem), new Uint8Array(0), concat(utf8(label + "-pq"), transcript));
}

/**
 * Seals `plain` for a device's public keys `{ enc, kem }`, hybrid: b64u of 0x01 ‖ ephemeral X25519 public key ‖
 * ML-KEM-768 ciphertext ‖ nonce ‖ AES-GCM. A device without an ML-KEM key gets nothing sealed.
 */
async function sealFor(label, recipient, plain) {
  if (!recipient.kem) throw new ProtocolError("this device has no ML-KEM key");
  const ephemeral = await generatePair("X25519");
  const sharedX = await x25519(ephemeral.privateKey, recipient.enc);
  const { ciphertext, sharedSecret } = await mlkemEncapsulate(recipient.kem);
  const key = await hybridKey(label, sharedX, sharedSecret, ephemeral.publicKey, recipient, ciphertext);
  const { nonce, sealed } = await seal(key, plain);
  return b64u(concat(Uint8Array.of(HYBRID), ephemeral.publicKey, ciphertext, nonce, sealed));
}

// Opens `sealFor`'s output with a device's keys `{ enc, kem: { seed, publicKey } }`; only hybrid seals open.
async function openFor(label, text, keys) {
  const raw = fromB64u(text);
  if (!keys.kem || !isHybrid(text)) throw new ProtocolError("not a hybrid seal");
  const ephemeralPublic = raw.subarray(1, 33), ciphertext = raw.subarray(33, HYBRID_HEAD);
  const sharedX = await x25519(keys.enc.privateKey, ephemeralPublic);
  const sharedKem = await mlkemDecapsulate(keys.kem.seed, ciphertext);
  const key = await hybridKey(label, sharedX, sharedKem, ephemeralPublic, recipientOf(keys), ciphertext);
  return open(key, raw.subarray(HYBRID_HEAD, HYBRID_HEAD + NONCE_BYTES), raw.subarray(HYBRID_HEAD + NONCE_BYTES));
}

/** Whether a sealed value (a wrapped file key, relay payload or card) is hybrid, i.e. safe from a future quantum computer. */
export function isHybrid(text) {
  const raw = fromB64u(text);
  return raw[0] === HYBRID && raw.length >= HYBRID_HEAD + NONCE_BYTES + 16;
}

/** A file key wrapped for a device's public keys `{ enc, kem }` (`sealFor`, label `notedown-wrap`). */
export function wrapFileKey(fileKey, recipient) {
  return sealFor("notedown-wrap", recipient, fileKey);
}

/** The 32-byte file key from `wrapFileKey`'s output; `keys` are this device's `{ enc, kem }` (as `generateDeviceKeys`). */
export function unwrapFileKey(wrapped, keys) {
  return openFor("notedown-wrap", wrapped, keys);
}

// ---------- signed wraps (docs/server-api.md → "Keys": signed wrapped key) ----------

const SIGNED = 0x02;
const SIGNED_HEAD = 1 + 4 + 16 + 64;   // marker ‖ generation ‖ signer ID ‖ Ed25519 signature

// What the signer vouches for: this key wrap is for device `to`, of file `file`, the file's key generation `gen`.
const wrapStatement = ({ file, to, gen, signer, wrap }) =>
  canonicalJson({ label: "notedown-wrap-sig", file, to, gen, signer, wrap });

/**
 * A wrapped file key signed by the device that made it, so the server can't hand a device a key of its own
 * choosing: b64u of 0x02 ‖ `gen` (u32, big-endian) ‖ the signer's device ID (16 bytes) ‖ Ed25519 signature ‖
 * the hybrid wrap (`wrapFileKey`). The signature covers file ID, recipient device ID, generation, signer and wrap.
 */
export async function signWrap(wrap, { file, to, gen }, signer, signKey) {
  if (!Number.isSafeInteger(gen) || gen < 1 || gen > 0xffffffff) throw new ProtocolError("invalid key generation");
  const sig = new Uint8Array(await subtle().sign({ name: "Ed25519" }, signKey, wrapStatement({ file, to, gen, signer, wrap })));
  const head = new Uint8Array(1 + 4);
  head[0] = SIGNED;
  new DataView(head.buffer).setUint32(1, gen);
  return b64u(concat(head, fromB64u(signer, 16), sig, fromB64u(wrap)));
}

/** The parts of `signWrap`'s output: { gen, signer, sig, wrap }; ProtocolError for anything else (an unsigned wrap). */
export function readSignedWrap(text) {
  const raw = fromB64u(text);
  if (raw[0] !== SIGNED || raw.length <= SIGNED_HEAD) throw new ProtocolError("the wrapped key isn't signed");
  return {
    gen: new DataView(raw.buffer, raw.byteOffset).getUint32(1),
    signer: b64u(raw.subarray(5, 21)),
    sig: raw.subarray(21, SIGNED_HEAD),
    wrap: b64u(raw.subarray(SIGNED_HEAD)),
  };
}

/** Whether `signed` (from `readSignedWrap`) was signed by the device with Ed25519 key `signPublicKey` for `file` and `to`. */
export function verifyWrap(signed, { file, to }, signPublicKey) {
  return verifySignature(signPublicKey, signed.sig, wrapStatement({ file, to, gen: signed.gen, signer: signed.signer, wrap: signed.wrap }));
}

/** The relay payload for a new device: `message` (JSON-able) sealed like a file key, label `notedown-relay`. */
export function sealRelayMessage(message, recipient) {
  return sealFor("notedown-relay", recipient, utf8(JSON.stringify(message)));
}

/** The message of `sealRelayMessage`'s output; throws when it wasn't sealed for these device keys. */
export async function openRelayMessage(payload, keys) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await openFor("notedown-relay", payload, keys)));
}

// ---------- contacts and invitations (docs/server-api.md → "Contacts and invitations") ----------

const SECRET_BYTES = 16;

/** A new invitation secret: 16 random bytes (also the secret of a link code, `core/linking.js`). */
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

/** A contact request's card (JSON-able) sealed like a relay payload for a device's public keys, label `notedown-contact`. */
export function sealContactCard(card, recipient) {
  return sealFor("notedown-contact", recipient, utf8(JSON.stringify(card)));
}

/** The card of `sealContactCard`'s output; throws when it wasn't sealed for these device keys. */
export async function openContactCard(sealed, keys) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await openFor("notedown-contact", sealed, keys)));
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

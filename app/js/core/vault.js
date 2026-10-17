// The local vault (backlog #19, docs/sync-and-sharing.md → "Where the files live"):
// everything NoteDown keeps on the device — the notes files, the sync state, the
// settings, the file keys — is stored as records sealed with one data key
// (AES-256-GCM) that the app can use but not read out: in the web app a
// non-extractable WebCrypto key, in the Android app a key sealed by the Android
// Keystore. This module is the platform-free part: the record encoding, sealing
// and opening, and moving the data an older version stored in plain text into
// the vault. The platforms (IndexedDB, the native plugin) are app/js/vault.js.

const subtle = () => globalThis.crypto.subtle;
const utf8 = text => new TextEncoder().encode(text);
const NONCE_BYTES = 12;
const VERSION = 1;

// ---------- values ----------

// Records hold JSON; byte arrays (file keys) are tagged so they come back as Uint8Array.
const toB64 = bytes => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

/** A value (JSON-able, with Uint8Array allowed anywhere) as text. */
export function encodeValue(value) {
  return JSON.stringify(value, function (k, v) {
    const raw = this[k];
    return raw instanceof Uint8Array ? { $bytes: toB64(raw) } : v;
  });
}

/** The value of `encodeValue`'s text. */
export function decodeValue(text) {
  return JSON.parse(text, (k, v) => (v && typeof v === "object" && typeof v.$bytes === "string" && Object.keys(v).length === 1 ? fromB64(v.$bytes) : v));
}

/** Whether two values encode alike (the read-back check of the migration). */
export const sameValue = (a, b) => encodeValue(a) === encodeValue(b);

// ---------- records ----------

// The record's name is authenticated with it, so a record can't be passed off as another one.
const aad = name => utf8(`notedown-vault:${VERSION}:${name}`);

/** A record: version byte ‖ nonce ‖ AES-GCM(data key, value), the name as additional data. */
export async function sealRecord(key, name, value) {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad(name) }, key, utf8(encodeValue(value))));
  const out = new Uint8Array(1 + NONCE_BYTES + sealed.length);
  out[0] = VERSION;
  out.set(nonce, 1);
  out.set(sealed, 1 + NONCE_BYTES);
  return out;
}

/** The value of a record; throws when it was changed, sealed for another name or with another key. */
export async function openRecord(key, name, bytes) {
  if (bytes[0] !== VERSION) throw new Error("Unknown vault record version");
  const plain = await subtle().decrypt({ name: "AES-GCM", iv: bytes.subarray(1, 1 + NONCE_BYTES), additionalData: aad(name) }, key, bytes.subarray(1 + NONCE_BYTES));
  return decodeValue(new TextDecoder("utf-8", { fatal: true }).decode(plain));
}

/** A new data key for the web vault: AES-256-GCM, not extractable. */
export function generateVaultKey() {
  return subtle().generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** The Android vault's data key from its 32 bytes (unsealed by the Keystore), not extractable; the bytes are wiped. */
export async function importVaultKey(bytes) {
  try {
    return await subtle().importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  } finally {
    bytes.fill(0);
  }
}

// ---------- moving plain data into the vault ----------

// What versions before the vault kept in localStorage, and under which vault names it lives now. Every other
// `notedown.` key (none known) moves under its own name; `notedown.api` (a server address for local testing,
// no note data) stays in localStorage.
export const LEGACY_PREFIX = "notedown.";
export const KEEP_PLAIN = ["notedown.api"];
/** Vault names of the secrets (file keys) from the old key store in IndexedDB: `secret:<its key>`. */
export const secretName = key => "secret:" + key;

/**
 * Moves the plain data of an older version into the vault, then removes it — but only once every item reads
 * back from the vault unchanged, so an interrupted or failed run leaves the plain copy and the next start
 * tries again. An item the vault already has is newer (written by this version) and not overwritten.
 *
 * `legacy`: { items(): [{ name, value }] (vault names), remove(names) }; `vault`: { get(name), put(name, value) }.
 * Returns { moved: [names], removed: [names] }.
 */
export async function migrateLegacy(legacy, vault) {
  const items = await legacy.items();
  if (!items.length) return { moved: [], removed: [] };
  const moved = [];
  for (const { name, value } of items) {
    if ((await vault.get(name)) !== undefined) continue;
    await vault.put(name, value);
    moved.push(name);
  }
  for (const { name, value } of items) {
    const stored = await vault.get(name);
    if (stored === undefined) throw new Error(`Vault migration: ${name} missing after writing`);
    // Taken over before (an interrupted run): the vault's copy wins, the plain one may go.
    if (moved.includes(name) && !sameValue(stored, value)) throw new Error(`Vault migration: ${name} reads back changed`);
  }
  const removed = items.map(i => i.name);
  await legacy.remove(removed);
  return { moved, removed };
}

/** The localStorage keys an older version wrote, as [{ key, name }] (`name`: the vault record). */
export function legacyStorageKeys(keys) {
  return keys.filter(k => k.startsWith(LEGACY_PREFIX) && !KEEP_PLAIN.includes(k)).map(k => ({ key: k, name: k }));
}

/** Whether a key-store value is plain data the vault can hold (no CryptoKey objects inside). */
export function isVaultable(value) {
  if (value === null || typeof value !== "object" || value instanceof Uint8Array) return true;
  if (typeof CryptoKey !== "undefined" && value instanceof CryptoKey) return false;
  return Object.values(value).every(isVaultable);
}

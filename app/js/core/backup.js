// The encrypted backup (backlog #56, docs/requirements.md → "Encrypted backup"): one file with every note
// (private and shared) and the settings, which the user saves where they like and which only the backup key
// opens — 30 digits shown once, like Signal's backup passphrase. No keys of the identity or the device go
// into it: restoring one must not clone a device. Pure logic on WebCrypto.
import { parseNotesFile, serializeNotesFile } from "./notes-file.js";

const MAGIC = "NDBACKUP";
const VERSION = 1;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
export const ITERATIONS = 200000;   // PBKDF2-SHA256; the key's ~100 bits carry the strength, the cost slows guessing
const HEADER_BYTES = MAGIC.length + 1 + SALT_BYTES + 4 + NONCE_BYTES;
export const KEY_DIGITS = 30;

const subtle = () => globalThis.crypto.subtle;
const utf8 = text => new TextEncoder().encode(text);

/** A new backup key: 30 random digits (≈ 100 bits), as six groups of five. */
export function generateBackupKey(random = n => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  let digits = "";
  while (digits.length < KEY_DIGITS) {
    for (const b of random(KEY_DIGITS)) if (b < 250 && digits.length < KEY_DIGITS) digits += String(b % 10);   // no bias
  }
  return formatBackupKey(digits);
}

/** The digits of a typed key (spaces, dashes and other separators dropped), or null unless 30 digits. */
export function normalizeBackupKey(text) {
  const digits = String(text || "").replace(/\D/g, "");
  return digits.length === KEY_DIGITS ? digits : null;
}

/** "12345 67890 …": the 30 digits in groups of five. */
export const formatBackupKey = digits => digits.replace(/\D/g, "").match(/.{1,5}/g).join(" ");

async function deriveKey(digits, salt, iterations) {
  const base = await subtle().importKey("raw", utf8(digits), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function through(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

/** What a backup holds: the private file, the shared files and the settings, as of `created`. */
export function backupContents({ file, shared, settings }, created) {
  return {
    format: VERSION, created,
    file: serializeNotesFile(file),
    shared: shared.map(s => ({ members: [...s.members], text: serializeNotesFile(s.file) })),
    settings,
  };
}

/** The backup file: "NDBACKUP" ‖ version ‖ salt ‖ iterations (u32) ‖ nonce ‖ AES-GCM(compressed JSON), the header as additional data. */
export async function sealBackup(contents, key, { iterations = ITERATIONS } = {}) {
  const digits = normalizeBackupKey(key);
  if (!digits) throw new Error("A backup key has 30 digits");
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const header = new Uint8Array(HEADER_BYTES);
  header.set(utf8(MAGIC), 0);
  header[MAGIC.length] = VERSION;
  header.set(salt, MAGIC.length + 1);
  new DataView(header.buffer).setUint32(MAGIC.length + 1 + SALT_BYTES, iterations);
  header.set(nonce, MAGIC.length + 1 + SALT_BYTES + 4);
  const packed = await through(utf8(JSON.stringify(contents)), new CompressionStream("deflate-raw"));
  const sealed = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: nonce, additionalData: header }, await deriveKey(digits, salt, iterations), packed));
  const out = new Uint8Array(HEADER_BYTES + sealed.length);
  out.set(header);
  out.set(sealed, HEADER_BYTES);
  return out;
}

export class BackupError extends Error {}

/** The contents of a backup file; BackupError "not a backup" or "wrong key" (also for a changed file). */
export async function openBackup(bytes, key) {
  if (bytes.length < HEADER_BYTES + 16 || new TextDecoder().decode(bytes.subarray(0, MAGIC.length)) !== MAGIC) throw new BackupError("This file isn't a NoteDown backup.");
  if (bytes[MAGIC.length] !== VERSION) throw new BackupError("This backup is from a newer NoteDown. Update the app first.");
  const digits = normalizeBackupKey(key);
  if (!digits) throw new BackupError("The backup key has 30 digits.");
  const header = bytes.subarray(0, HEADER_BYTES);
  const salt = header.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT_BYTES);
  const iterations = new DataView(header.buffer, header.byteOffset).getUint32(MAGIC.length + 1 + SALT_BYTES);
  const nonce = header.subarray(MAGIC.length + 1 + SALT_BYTES + 4);
  let packed;
  try {
    packed = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: nonce, additionalData: header }, await deriveKey(digits, salt, iterations), bytes.subarray(HEADER_BYTES)));
  } catch {
    throw new BackupError("The backup key doesn't fit this backup.");
  }
  return JSON.parse(new TextDecoder().decode(await through(packed, new DecompressionStream("deflate-raw"))));
}

/** "notedown-backup-2026-10-17.ndbackup" */
export const backupFileName = day => `notedown-backup-${day}.ndbackup`;

/**
 * What restoring adds: the backup's notes (private and shared, not the trash) that no file on this device
 * has — as private notes, since sharing belongs to the identity. Nothing on the device is overwritten.
 * `existingIds`: the ids of every note here, trash and shared files included. → [notes]
 */
export function notesToRestore(contents, existingIds) {
  const have = new Set(existingIds);
  const plain = ({ kept, left, ...n }) => n;
  const all = [parseNotesFile(contents.file), ...contents.shared.map(s => parseNotesFile(s.text))].flatMap(f => f.notes);
  const out = [];
  for (const n of all) {
    if (n.deleted || have.has(n.id)) continue;
    have.add(n.id);
    out.push(plain(n));
  }
  return out;
}

// Real sync of the private file with the server (docs/sync-and-sharing.md →
// "Identity and devices", "Sync"; protocol: docs/server-api.md). Turning sync
// on creates the identity, linking by QR code or restoring with the recovery
// key adds this device, and each round downloads, merges and uploads the end-to-end encrypted file.
// Rounds run shortly after a change, on start, when the app comes back to the
// foreground, gets the focus or goes online, every 5 s while it is visible,
// and when the user asks (opening Sync & sharing, pull to refresh). The sample
// (`state.sync.simulated`) never reaches this module.
import { state, setSync, setPrivateFile, fileText, onFilesChanged, eraseStoredState } from "../store.js";
import { parseNotesFile, serializeNotesFile } from "../core/notes-file.js";
import { mergeNotesFiles } from "../core/merge.js";
import * as c from "../core/crypto.js";
import { onlyUntouchedWelcome, keyHolders, withDeviceName } from "../core/sync-state.js";
import { linkCode, parseLinkCode, relayMessage, parseRelayMessage, deviceLabel } from "../core/linking.js";
import { createApi, ApiError, NetworkError } from "./api.js";
import { getSecret, setSecret, clearSecrets, deleteDatabase } from "./keystore.js";

const AFTER_CHANGE_MS = 1500;
const POLL_MS = 5000;
const ATTEMPTS = 3;
const MIN_BUSY_MS = 800;   // "syncing" stays long enough to be seen
const SLOT_POLL_MS = 2000;

let api = null;
let keys = null;         // this device's { sign, enc } key pairs
let fileKey = null;      // the private file's key (32 bytes)
let caller = null;       // while restoring: the recovery device signs in
let running = null, again = false, timer = null, poll = null, busySince = 0;

const active = () => api && state.sync.enabled && !state.sync.simulated;
const emptyFile = () => parseNotesFile("");

/** Starts sync against the server at `apiUrl` (none: sync can't be turned on). */
export function initSync(apiUrl) {
  if (!apiUrl) return;
  api = createApi(apiUrl, () => caller || { identity: state.sync.identity, device: state.sync.device, sign: keys.sign.privateKey });
  onFilesChanged(() => schedule(AFTER_CHANGE_MS));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(0); });
  // The Android app (Capacitor) reports coming back to the foreground as "resume".
  for (const target of [document, window]) target.addEventListener("resume", () => schedule(0));
  window.addEventListener("focus", () => schedule(0));
  window.addEventListener("online", () => schedule(0));
  poll = setInterval(() => { if (!document.hidden) schedule(0); }, POLL_MS);
  schedule(0);
}

/** True when this copy of the app knows a sync server. */
export const syncAvailable = () => Boolean(api);

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(syncNow, ms);
}

/** Runs a sync round now (or once more after the running one); `show`: the
 *  user asked for it, so it shows "syncing" even when nothing changed. */
export function syncNow({ show = false } = {}) {
  if (!active()) return Promise.resolve();
  if (show && !state.editingId) busy();
  if (running) { again = true; return running; }
  running = (async () => {
    do { again = false; await round(); } while (again);
  })().finally(() => { running = null; });
  return running;
}

async function round() {
  // Remote changes wait while a note is being edited; ending the edit syncs.
  if (state.editingId) return;
  try {
    await loadKeys();
    let done = false;
    for (let i = 0; i < ATTEMPTS && !done; i++) done = await step();
    const wait = busySince + MIN_BUSY_MS - Date.now();
    if (state.sync.status === "syncing" && wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    setSync({ status: "synced", lastSync: Date.now(), error: "" });
  } catch (e) {
    fail(e);
  }
}

function fail(e) {
  if (e instanceof NetworkError) return setSync({ status: "offline", error: "" });
  // The server refuses a device that is no longer on the list (401 after a fresh token).
  const removed = e instanceof ApiError && (e.status === 401 || e.status === 403);
  setSync({ status: "error", error: removed ? "This device was removed from sync" : e.message || e.name });
}

function busy() {
  if (state.sync.status === "syncing") return;
  busySince = Date.now();
  setSync({ status: "syncing" });
}

async function loadKeys() {
  keys ||= await getSecret("device");
  if (!keys) throw new Error("This device's keys are missing");
  if (!fileKey && state.sync.file) fileKey = await getSecret("file:" + state.sync.file.id) || null;
}

// One download / merge / upload pass; false when the server moved on meanwhile.
async function step() {
  const files = await api.listFiles();
  if (!state.sync.file) {
    if (!files.length) return createFile();
    // Another device created the file first: take it over, merging everything.
    setSync({ file: { id: files[0].id, version: 0, base: "" } });
  }
  const f = state.sync.file;
  const server = files.find(x => x.id === f.id);
  if (!server) throw new Error("The notes file is missing on the server");
  if (server.version < f.version) throw new Error("The server sent an older version than this device has seen");
  const local = fileText();
  if (server.version > f.version || !fileKey) {
    busy();
    const remote = await download(f.id);
    if (remote.version < f.version) throw new Error("The server sent an older version than this device has seen");
    if (fileText() !== local) return false;       // edited meanwhile: start over
    const merged = mergeNotesFiles(parseNotesFile(f.base), parseNotesFile(local), parseNotesFile(remote.text)).file;
    if (serializeNotesFile(merged) !== local) setPrivateFile(merged);
    setSync({ file: { id: f.id, version: remote.version, base: remote.text } });
    if (fileText() === remote.text) return true;
  } else if (local === f.base) return true;
  busy();
  return upload(state.sync.file.version, fileText());
}

async function download(id) {
  const r = await api.getFile(id);
  if (!r.key) throw new Error("No key for this device on the server");
  const key = await c.unwrapFileKey(r.key, keys.enc);
  if (!fileKey || c.b64u(key) !== c.b64u(fileKey)) {   // renewed after a device was removed
    fileKey = key;
    await setSecret("file:" + id, key);
  }
  return { version: r.version, text: await c.decryptFile(key, r.ciphertext) };
}

// PUT of `text` on top of `baseVersion`; with `holders`, the key is (re)wrapped
// for them. False on a version conflict.
async function upload(baseVersion, text, holders = null, key = fileKey) {
  const id = state.sync.file.id;
  const body = { base_version: baseVersion, ciphertext: await c.encryptFile(key, text) };
  if (holders) body.keys = await wrapFor(holders, key);
  try {
    const { version } = await api.putFile(id, body);
    setSync({ file: { id, version, base: text } });
    if (fileText() !== text) again = true;
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) return false;
    throw e;
  }
}

async function wrapFor(devices, key) {
  return Object.fromEntries(await Promise.all(devices.map(async d => [d.id, await c.wrapFileKey(key, d.enc)])));
}

// The private file's first upload, with its key wrapped for every device.
async function createFile() {
  busy();
  const { devices } = await chain();
  const id = c.b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  fileKey = c.generateFileKey();
  await setSecret("file:" + id, fileKey);
  setSync({ file: { id, version: 0, base: "" } });
  return upload(0, fileText(), keyHolders(devices));
}

// The verified device list: { devices (Map), entries }.
async function chain() {
  const { identity_key: identityKey, entries } = await api.getIdentity(state.sync.identity);
  if (identityKey !== state.sync.identityKey) throw new Error("The server answered with another identity");
  return { devices: await c.verifyChain(c.fromB64u(identityKey, 32), entries), entries };
}

/** The verified devices of this identity (Map), for the device list. */
export async function loadDevices() {
  await loadKeys();
  return (await chain()).devices;
}

async function adopt({ name, identity, identityKey, device }) {
  await clearSecrets();
  await setSecret("device", device);
  keys = device;
  fileKey = null;
  setSync({
    enabled: true, simulated: false, name, identity, identityKey: c.b64u(identityKey),
    device: await c.keyId(device.sign.publicKey), file: null, recoveryKey: "", status: "syncing", error: "",
  });
}

/** Turns sync on: creates the identity for the recovery key shown to the user, then uploads the notes. */
export async function turnOn(name, recoveryKey) {
  const r = await c.deriveRecovery(c.recoveryKeyBytes(recoveryKey));
  const device = await c.generateDeviceKeys();
  const identity = await c.keyId(r.identity.publicKey);
  const add = async (entries, keyPair, kind) =>
    c.signEntry(await c.newEntry(identity, entries, "add", await c.deviceRecord(keyPair, kind)), "identity", r.identity.privateKey);
  const first = await add([], device, "device");
  const second = await add([first], r.recovery, "recovery");
  try {
    await api.createIdentity(c.b64u(r.identity.publicKey), [first, second]);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) throw new Error("This recovery key is already in use");
    throw e;
  }
  await adopt({ name, identity, identityKey: r.identity.publicKey, device });
  nameThisDevice();
  await syncNow();
}

// This device's suggested name into the private file (docs/file-format.md → "Device names").
function nameThisDevice() {
  setPrivateFile(withDeviceName(state.file, state.sync.device, deviceLabel(navigator.userAgent)));
}

/**
 * Adds this device to the identity of a recovery key: signs in as the
 * recovery device, appends this device to the list, wraps the file key for
 * it and merges the notes on this device with the synced ones.
 */
export async function restore(recoveryKey) {
  const r = await c.deriveRecovery(c.recoveryKeyBytes(recoveryKey));
  const identity = await c.keyId(r.identity.publicKey);
  const recoveryId = await c.keyId(r.recovery.sign.publicKey);
  const device = await c.generateDeviceKeys();
  const deviceId = await c.keyId(device.sign.publicKey);
  let found;
  try {
    found = await api.getIdentity(identity);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) throw new Error("No notes are synced with this recovery key");
    throw e;
  }
  if (found.identity_key !== c.b64u(r.identity.publicKey)) throw new Error("The server answered with another identity");
  let remote = null;
  caller = { identity, device: recoveryId, sign: r.recovery.sign.privateKey };
  try {
    for (let entries = found.entries; ;) {
      await c.verifyChain(r.identity.publicKey, entries);
      const body = await c.newEntry(identity, entries, "add", await c.deviceRecord(device, "device"));
      try {
        await api.appendEntry(identity, await c.signEntry(body, recoveryId, r.recovery.sign.privateKey));
        break;
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 409)) throw e;
        entries = (await api.getIdentity(identity)).entries;   // another device appended first
      }
    }
    // Milestone 1: the private file is the identity's only file.
    const [file] = await api.listFiles();
    if (file) {
      const got = await api.getFile(file.id);
      const key = await c.unwrapFileKey(got.key, r.recovery.enc);
      await api.addKeys(file.id, { [deviceId]: await c.wrapFileKey(key, device.enc.publicKey) });
      remote = { id: file.id, version: got.version, key, text: await c.decryptFile(key, got.ciphertext) };
    }
  } finally {
    caller = null;
    api.forgetToken();
  }
  await adopt({ name: state.sync.name, identity, identityKey: r.identity.publicKey, device });
  if (remote) {
    fileKey = remote.key;
    await setSecret("file:" + remote.id, remote.key);
    const local = onlyUntouchedWelcome(state.file) ? emptyFile() : state.file;
    setPrivateFile(mergeNotesFiles(emptyFile(), local, parseNotesFile(remote.text)).file);
    setSync({ file: { id: remote.id, version: remote.version, base: remote.text } });
  }
  nameThisDevice();
  await syncNow();
}

/**
 * The new device's side of linking by QR code: new device keys and a relay
 * slot; `code` is the text of the QR code to show. Then `waitForLink`.
 */
export async function startLinking() {
  const device = await c.generateDeviceKeys();
  const { slot, expires } = await api.createSlot();
  const code = linkCode({ slot, sign: c.b64u(device.sign.publicKey), enc: c.b64u(device.enc.publicKey), name: deviceLabel(navigator.userAgent) });
  return { device, slot, code, expires: Date.parse(expires) };
}

/**
 * Polls the slot of `startLinking` until a linked device has filled it, then
 * joins that identity: checks that the verified device list holds this
 * device, takes over the keys and merges the notes on the next sync round.
 * Resolves false when `cancelled()` became true; throws when the slot
 * expired (ApiError 404) or the answer doesn't add up.
 */
export async function waitForLink({ device, slot }, cancelled) {
  let payload = null;
  while (!payload) {
    if (cancelled()) return false;
    try {
      payload = await api.readSlot(slot);
    } catch (e) {
      if (!(e instanceof NetworkError)) throw e;   // offline for a moment: keep polling
    }
    if (!payload) await new Promise(resolve => setTimeout(resolve, SLOT_POLL_MS));
  }
  let message;
  try {
    message = parseRelayMessage(await c.openRelayMessage(payload, device.enc));
  } catch { /* not sealed for this device */ }
  if (!message) throw new Error("The other device sent an answer this device can't read");
  const { identity_key: identityKey, entries } = await api.getIdentity(message.identity);
  const keyBytes = c.fromB64u(identityKey, 32);
  if (await c.keyId(keyBytes) !== message.identity) throw new Error("The server answered with another identity");
  const devices = await c.verifyChain(keyBytes, entries);
  if (!devices.get(await c.keyId(device.sign.publicKey))?.active) throw new Error("This device isn't on the device list; scan the code again");
  if (onlyUntouchedWelcome(state.file)) setPrivateFile(emptyFile());
  await adopt({ name: message.name, identity: message.identity, identityKey: keyBytes, device });
  await syncNow();
  return true;
}

/** `{ name }` of a scanned code if it is a link code, else null (for the confirmation). */
export function readLinkCode(text) {
  const parsed = parseLinkCode(text);
  return parsed && { name: parsed.name };
}

/**
 * The linked device's side: appends the device of a scanned link code to the
 * device list, wraps the file key for it, writes its name into the private
 * file and leaves the identity ID and display name, sealed for the new
 * device, in its relay slot.
 */
export async function linkDevice(text) {
  const code = parseLinkCode(text);
  if (!code) throw new Error("That's not the code of a NoteDown device");
  const expired = new Error("The code has expired. Show a new one on the other device and scan again");
  try {
    await api.readSlot(code.slot);   // still open (204), before the device goes on the list
  } catch (e) {
    throw e instanceof ApiError && e.status === 404 ? expired : e;
  }
  await syncNow();
  await loadKeys();
  if (!state.sync.file || !fileKey) throw new Error("Sync first, then link the device");
  const record = { id: await c.keyId(c.fromB64u(code.sign, 32)), kind: "device", sign: code.sign, enc: code.enc };
  for (let entries = (await chain()).entries; ;) {
    const body = await c.newEntry(state.sync.identity, entries, "add", record);
    try {
      await api.appendEntry(state.sync.identity, await c.signEntry(body, state.sync.device, keys.sign.privateKey));
      break;
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409)) throw e;
      entries = (await chain()).entries;   // another device appended first
    }
  }
  await api.addKeys(state.sync.file.id, { [record.id]: await c.wrapFileKey(fileKey, c.fromB64u(code.enc, 32)) });
  if (code.name) {
    setPrivateFile(withDeviceName(state.file, record.id, code.name));
    await syncNow();
  }
  try {
    await api.fillSlot(code.slot, await c.sealRelayMessage(relayMessage(state.sync.identity, state.sync.name), c.fromB64u(code.enc, 32)));
  } catch (e) {
    throw e instanceof ApiError && e.status === 409 ? expired : e;
  }
}

/**
 * Removes another device: appends the removal to the device list, then
 * renews the file key so the removed device can't read later versions.
 */
export async function removeDevice(id) {
  await syncNow();
  await loadKeys();
  const { devices, entries } = await chain();
  const body = await c.newEntry(state.sync.identity, entries, "remove", { id });
  await api.appendEntry(state.sync.identity, await c.signEntry(body, state.sync.device, keys.sign.privateKey));
  devices.get(id).active = false;
  setPrivateFile(withDeviceName(state.file, id, null));
  const key = c.generateFileKey();
  for (let i = 0; i < ATTEMPTS; i++) {
    if (await upload(state.sync.file.version, fileText(), keyHolders(devices), key)) {
      fileKey = key;
      await setSecret("file:" + state.sync.file.id, key);
      return;
    }
    await syncNow();
  }
  throw new Error("Couldn't renew the file key; try again");
}

/**
 * Erases everything NoteDown keeps on this device (notes, settings, sync
 * state in localStorage; device and file keys in IndexedDB) and stops syncing.
 * The caller reloads the page afterwards.
 */
export async function eraseDevice() {
  clearInterval(poll);
  clearTimeout(timer);
  api = null;   // no sync round starts from here on
  eraseStoredState();
  keys = fileKey = null;
  await deleteDatabase();
}

/**
 * Signs this device out: syncs, then appends the removal of this device to the
 * device list (signed by itself) and erases the local data. The file key is
 * not renewed: a device that erases itself needs no lock-out, and one that was
 * copied is removed from another device, which renews it.
 */
export async function signOut() {
  await syncNow();
  if (state.sync.status === "error") throw new Error(state.sync.error || "Sync failed");
  await loadKeys();
  if (state.sync.file && fileText() !== state.sync.file.base) throw new Error("Your latest changes aren't synced yet; try again");
  for (let entries = (await chain()).entries; ;) {
    const body = await c.newEntry(state.sync.identity, entries, "remove", { id: state.sync.device });
    try {
      await api.appendEntry(state.sync.identity, await c.signEntry(body, state.sync.device, keys.sign.privateKey));
      break;
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409)) throw e;
      entries = (await chain()).entries;   // another device appended first
    }
  }
  await eraseDevice();
}

// Real sync with the server (docs/sync-and-sharing.md → "Identity and devices",
// "Sync"; protocol: docs/server-api.md). Turning sync on creates the identity,
// linking by QR code or restoring with the recovery key adds this device, and
// each round downloads, merges and uploads the end-to-end encrypted files — the
// private one and the shared ones (files.js).
// Rounds run shortly after a change, on start, when the app comes back to the
// foreground, gets the focus or goes online, while the app is visible every
// 5 s that grows to 30 s as long as nothing changes (any change, focus or
// user request makes it 5 s again), and when the user asks (opening Sync &
// sharing, pull to refresh); each round also brings contact requests and
// confirmations (contacts.js). The sample
// (`state.sync.simulated`) never reaches this module.
import { state, setSync, setPrivateFile, onFilesChanged, eraseStoredState, contacts, sharedFiles, replaceFiles } from "../store.js";
import * as c from "../core/crypto.js";
import { withoutUntouchedWelcome, withDeviceName, nextPollDelay, POLL_MIN_MS, limitRefusal, detachedFile } from "../core/sync-state.js";
import { deleteWithRecoveryKey } from "./delete-identity.js";
import { linkCode, parseLinkCode, relayMessage, parseRelayMessage, deviceLabel, serverUrl } from "../core/linking.js";
import { createApis, ApiError, NetworkError } from "./api.js";
import { initContacts, contactsRound } from "./contacts.js";
import { initFiles, filesRound, forgetKeys, grantKeys, unsynced, markRenew, readForRestore, installRestored,
  listVersions, readVersion, restoreVersion, saveVersion } from "./files.js";
import { getSecret, setSecret, clearSecrets, deleteDatabase } from "./keystore.js";

const AFTER_CHANGE_MS = 1500;
const ATTEMPTS = 3;
const MIN_BUSY_MS = 800;   // "syncing" stays long enough to be seen
const SLOT_POLL_MS = 2000;

let apis = null;         // server URL → API client (sync/api.js)
let api = null;          // the client of the default server: where a new identity, a slot or a recovery key is looked for
let defaultServer = ""; // the configured API address (app/config.json, ?api=)
let keys = null;         // this device's { sign, enc } key pairs
let caller = null;       // while restoring: the recovery device signs in
let running = null, again = false, timer = null, busySince = 0;
let pollTimer = null, pollDelay = POLL_MIN_MS;
let moved = false;       // the running sync downloaded or uploaded something

const active = () => api && state.sync.enabled && !state.sync.simulated;

// The identity's home server (a state saved before servers were named: the default one) and the client of
// a server ("" or none: the home server). Every call goes through the server of its file or contact.
const home = () => state.sync.server || defaultServer;
const serverApi = server => apis(server || home());

/** Starts sync against the server at `apiUrl` (none: sync can't be turned on); `webUrl` is the address
 *  of this app on the web, the start of invitation links (none: no links can be made). */
export function initSync(apiUrl, webUrl = "") {
  if (!apiUrl) return;
  defaultServer = serverUrl(new URL(apiUrl, location.href).href);   // a relative address too
  apis = createApis(() => caller || { identity: state.sync.identity, device: state.sync.device, sign: keys.sign.privateKey });
  api = apis(defaultServer);
  initContacts({ api: serverApi, home, defaultServer: () => defaultServer, keys: () => keys, loadKeys, chain, web: () => webUrl });
  initFiles({ api: serverApi, home, defaultServer: () => defaultServer, keys: () => keys, chain, busy, moved: () => { moved = true; } });
  onFilesChanged(() => { resetPoll(); schedule(AFTER_CHANGE_MS); });
  const wake = () => { resetPoll(); schedule(0); };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(); });
  // The Android app (Capacitor) reports coming back to the foreground as "resume".
  for (const target of [document, window]) target.addEventListener("resume", wake);
  window.addEventListener("focus", wake);
  window.addEventListener("online", wake);
  wake();
}

// Polling: one timer that re-arms itself. A poll round that moved nothing
// waits longer next time; anything that happens makes the delay 5 s again.
// Hidden tabs don't poll.
function armPoll() {
  clearTimeout(pollTimer);
  if (api) pollTimer = setTimeout(poll, pollDelay);
}

function resetPoll() {
  pollDelay = POLL_MIN_MS;
  armPoll();
}

async function poll() {
  if (!api) return;
  if (document.hidden) return armPoll();
  await syncNow();
  if (!api) return;   // erased meanwhile
  if (moved) resetPoll();
  else { pollDelay = nextPollDelay(pollDelay, false); armPoll(); }
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
  if (show) resetPoll();
  if (show && !state.editingId) busy();
  if (running) { again = true; return running; }
  moved = false;
  running = (async () => {
    do { again = false; await round(); } while (again);
  })().finally(() => { running = null; if (moved) resetPoll(); });
  return running;
}

async function round() {
  // Remote changes wait while a note is being edited; ending the edit syncs.
  if (state.editingId) return;
  try {
    await loadKeys();
    let done = false;
    let failure = null;   // a problem with a file doesn't keep back the contacts
    for (let i = 0; i < ATTEMPTS && !done && !failure; i++) {
      try {
        const pass = await filesRound();
        if (pass.again) again = true;
        done = pass.done;
      } catch (e) {
        failure = e;
      }
    }
    await contactsRound();
    if (failure) throw failure;
    const wait = busySince + MIN_BUSY_MS - Date.now();
    if (state.sync.status === "syncing" && wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    setSync({ status: "synced", lastSync: Date.now(), error: "", storageFull: false, blocked: null });
  } catch (e) {
    fail(e);
  }
}

// A member's name for a sync message: the contact's name, else the name they wrote into a shared file.
function memberName(id) {
  return contacts().find(x => x.id === id)?.name
    || sharedFiles().flatMap(f => f.file?.members || []).find(m => m.id === id)?.name || "";
}

function fail(e) {
  const limit = e instanceof ApiError ? limitRefusal(e.status, e.body, state.sync.identity, memberName) : null;
  const storageFull = !!limit?.own && limit.kind === "storage";
  if (state.sync.storageFull !== storageFull) setSync({ storageFull });
  if (limit && !limit.own) return setSync({ status: "error", error: limit.message });
  if (e instanceof NetworkError) return setSync({ status: "offline", error: "" });
  // Deleted (410), or this device is no longer on the list (401 after a fresh token): sync ends here.
  if (e instanceof ApiError && e.status === 410) return detach("deleted");
  if (e instanceof ApiError && e.status === 401) return detach("removed");
  const blocked = e instanceof ApiError && e.status === 423 ? { until: e.body.until ?? null } : null;
  setSync({ status: "error", error: e.message || e.name, blocked });
}

function busy() {
  if (state.sync.status === "syncing") return;
  busySince = Date.now();
  setSync({ status: "syncing" });
}

async function loadKeys() {
  keys ||= await getSecret("device");
  if (!keys) throw new Error("This device's keys are missing");
}

// The verified device list: { devices (Map), entries }.
async function chain() {
  const { identity_key: identityKey, entries } = await serverApi().getIdentity(state.sync.identity);
  if (identityKey !== state.sync.identityKey) throw new Error("The server answered with another identity");
  return { devices: await c.verifyChain(c.fromB64u(identityKey, 32), entries), entries };
}

/** The verified devices of this identity (Map), for the device list. */
export async function loadDevices() {
  await loadKeys();
  return (await chain()).devices;
}

async function adopt({ name, identity, server, identityKey, device }) {
  await clearSecrets();
  await setSecret("device", device);
  keys = device;
  forgetKeys();
  setSync({
    enabled: true, simulated: false, name, identity, server, identityKey: c.b64u(identityKey),
    device: await c.keyId(device.sign.publicKey), file: null, files: {}, epochs: {}, renew: [], usage: null, maxMembers: null, recoveryKey: "", status: "syncing", error: "", ended: "", blocked: null,
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
  await adopt({ name, identity, server: defaultServer, identityKey: r.identity.publicKey, device });
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
  let remote = [];
  // The recovery device signs in for everything below, reading the list included.
  caller = { identity, device: recoveryId, sign: r.recovery.sign.privateKey };
  try {
    let found;
    try {
      found = await api.getIdentity(identity);
    } catch (e) {
      // An unknown identity can't sign in (401) or isn't there (404).
      if (e instanceof ApiError && (e.status === 404 || e.status === 401)) throw new Error("No notes are synced with this recovery key");
      throw e;
    }
    if (found.identity_key !== c.b64u(r.identity.publicKey)) throw new Error("The server answered with another identity");
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
    // Every file of the identity, the shared ones too: the key is wrapped for the new device.
    remote = await readForRestore((await api.listFiles()).files, r.recovery.enc, deviceId, device.enc.publicKey);
  } finally {
    caller = null;
    apis.forgetTokens();
  }
  await adopt({ name: state.sync.name, identity, server: defaultServer, identityKey: r.identity.publicKey, device });
  await installRestored(remote, identity, withoutUntouchedWelcome(state.file));
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
  const code = linkCode({ slot, sign: c.b64u(device.sign.publicKey), enc: c.b64u(device.enc.publicKey), name: deviceLabel(navigator.userAgent), server: defaultServer });
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
  // Reading a list needs a token: this device signs in as itself, which works only once it is on the list.
  const deviceId = await c.keyId(device.sign.publicKey);
  caller = { identity: message.identity, device: deviceId, sign: device.sign.privateKey };
  let list;
  const server = message.server || defaultServer;   // the identity's home server
  try {
    list = await apis(server).getIdentity(message.identity);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) throw new Error("This device isn't on the device list; scan the code again");
    throw e;
  } finally {
    caller = null;
    apis.forgetTokens();
  }
  const { identity_key: identityKey, entries } = list;
  const keyBytes = c.fromB64u(identityKey, 32);
  if (await c.keyId(keyBytes) !== message.identity) throw new Error("The server answered with another identity");
  const devices = await c.verifyChain(keyBytes, entries);
  if (!devices.get(deviceId)?.active) throw new Error("This device isn't on the device list; scan the code again");
  if (withoutUntouchedWelcome(state.file) !== state.file) setPrivateFile(withoutUntouchedWelcome(state.file));
  await adopt({ name: message.name, identity: message.identity, server, identityKey: keyBytes, device });
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
  const slotApi = apis(code.server || defaultServer);   // the server the slot is on
  try {
    await slotApi.readSlot(code.slot);   // still open (204), before the device goes on the list
  } catch (e) {
    throw e instanceof ApiError && e.status === 404 ? expired : e;
  }
  await syncNow();
  await loadKeys();
  if (!state.sync.file) throw new Error("Sync first, then link the device");
  const record = { id: await c.keyId(c.fromB64u(code.sign, 32)), kind: "device", sign: code.sign, enc: code.enc };
  for (let entries = (await chain()).entries; ;) {
    const body = await c.newEntry(state.sync.identity, entries, "add", record);
    try {
      await serverApi().appendEntry(state.sync.identity, await c.signEntry(body, state.sync.device, keys.sign.privateKey));
      break;
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409)) throw e;
      entries = (await chain()).entries;   // another device appended first
    }
  }
  await grantKeys(record.id, c.fromB64u(code.enc, 32));   // the key of every file, the shared ones too
  if (code.name) {
    setPrivateFile(withDeviceName(state.file, record.id, code.name));
    await syncNow();
  }
  try {
    await slotApi.fillSlot(code.slot, await c.sealRelayMessage(relayMessage(state.sync.identity, state.sync.name, home()), c.fromB64u(code.enc, 32)));
  } catch (e) {
    throw e instanceof ApiError && e.status === 409 ? expired : e;
  }
}

/**
 * Removes another device: appends the removal to the device list, then
 * renews the key of every file (the shared ones too) so the removed device
 * can't read later versions. A key that can't be renewed now stays on a list
 * (`state.sync.renew`) and is renewed by a later round.
 */
export async function removeDevice(id) {
  await syncNow();
  await loadKeys();
  const { entries } = await chain();
  const body = await c.newEntry(state.sync.identity, entries, "remove", { id });
  await serverApi().appendEntry(state.sync.identity, await c.signEntry(body, state.sync.device, keys.sign.privateKey));
  setPrivateFile(withDeviceName(state.file, id, null));
  markRenew();
  for (let i = 0; i < ATTEMPTS && state.sync.renew.length; i++) await syncNow();
  if (state.sync.renew.length) throw new Error("The device is removed, but the file keys couldn't be renewed yet; sync will try again");
}

// ---------- version history (docs/requirements.md → "Version history") ----------

/** The older states the server keeps of a file (slot: circleKey, "" = private), newest first, after a sync round. */
export async function fileVersions(slot) {
  await syncNow();
  await loadKeys();
  return listVersions(slot);
}

/** The text of one older state of a file. */
export async function fileVersionText(slot, version) {
  await loadKeys();
  return readVersion(slot, version);
}

/**
 * "Back up now": after a sync round, the server keeps the current state of every file with a version history
 * (`state.sync.history`). → how many states were new (a file unchanged since its last backup adds none).
 */
export async function backUpNow() {
  await syncNow();
  if (state.sync.status === "error") throw new Error(state.sync.error || "Sync failed");
  let saved = 0;
  for (const slot of state.sync.history) if (await saveVersion(slot)) saved++;
  return saved;
}

/** Brings back an older state of a file for everyone in it; the state it replaces stays in the history. */
export async function restoreFileVersion(slot, version) {
  await syncNow();
  await loadKeys();
  await restoreVersion(slot, version);
  await syncNow();
  if (state.sync.restore.includes(slot)) throw new Error(state.sync.error || "The restored state isn't synced yet; sync will try again");
}

// ---------- deleting the identity (backlog #34) ----------

/**
 * Deletes this identity from the server with its recovery key: every device stops syncing and keeps its notes
 * as private notes; what others share with this user stays with them.
 */
export async function deleteIdentity(recoveryKey) {
  await deleteWithRecoveryKey(serverApi(), recoveryKey, state.sync.identity);
  await detach("deleted");
}

// The identity is gone from the server (`why` "deleted": here, on another device or by the server's owner) or this
// device was taken off its list ("removed"): sync ends on this device, the notes stay as private notes
// (core/sync-state.js → detachedFile), the keys are erased; a card above the notes says so (ui/sync-notice.js).
async function detach(why) {
  if (!state.sync.enabled) return;
  const file = detachedFile(state.file, state.shared, state.sync.identity);
  keys = null;
  forgetKeys();
  apis.forgetTokens();
  replaceFiles({ file, shared: [], sync: { ended: why } });
  await clearSecrets();
}

/**
 * Erases everything NoteDown keeps on this device (notes, settings, sync
 * state in localStorage; device and file keys in IndexedDB) and stops syncing.
 * The caller reloads the page afterwards.
 */
export async function eraseDevice() {
  clearTimeout(pollTimer);
  clearTimeout(timer);
  api = null;   // no sync round starts from here on
  apis = null;
  eraseStoredState();
  keys = null;
  forgetKeys();
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
  if (unsynced()) throw new Error("Your latest changes aren't synced yet; try again");
  for (let entries = (await chain()).entries; ;) {
    const body = await c.newEntry(state.sync.identity, entries, "remove", { id: state.sync.device });
    try {
      await serverApi().appendEntry(state.sync.identity, await c.signEntry(body, state.sync.device, keys.sign.privateKey));
      break;
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409)) throw e;
      entries = (await chain()).entries;   // another device appended first
    }
  }
  await eraseDevice();
}

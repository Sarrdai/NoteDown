// The files of a sync round (docs/sync-and-sharing.md → "Files", "Keys", "Sync"):
// the private file and the shared files, one per set of people. Each round lists
// the files the identity is a member of, downloads what changed, merges everything
// at once (so a note that moved from one file to another finds its way, see
// `displaced` in core/merge.js), then uploads what differs from the last synced
// state, creating the file of a new set of people with its key wrapped for every
// device of every member (the members' device lists verified against their IDs).
// A problem with one shared file (no key, a device list that doesn't check out) is
// reported after the others have been synced. The sample (`state.sync.simulated`)
// never reaches this module. Slots are named by circleKey: "" is the private file.
import { state, setSync, setPrivateFile, setSharedFile, sharedFiles, isProtected, setProtected, contacts, setNewsFeed } from "../store.js";
import { parseNotesFile, serializeNotesFile, timestamp } from "../core/notes-file.js";
import { mergeNotesFiles, applyDisplaced, protectedDeleted, adoptNotes, movedAway, renameDuplicates, hasLeft, rehomeTarget, rehomeNote } from "../core/merge.js";
import { circleKey } from "../core/sharing.js";
import { matchFiles, fileMembers, allKeyHolders, hasContent, serverRestored } from "../core/sync-state.js";
import * as c from "../core/crypto.js";
import { ApiError, NetworkError } from "./api.js";
import { getSecret, setSecret, deleteSecret } from "./keystore.js";

const PRIVATE = "";

let ctx = null;                 // { api(server), home(), defaultServer(), keys(), chain(), busy(), moved() }, from sync/client.js
const fileKeys = new Map();     // "<server>/<file ID>" → file key (32 bytes), read from IndexedDB on first use
let migrated = false;

/** Hands over what the sync client owns: the API, this device's keys, the verified own device list and the round's flags. */
export function initFiles(context) {
  ctx = context;
}

/** Forgets the file keys held in memory (the database was cleared). */
export function forgetKeys() {
  fileKeys.clear();
}

// ---------- slots ----------

const rec = key => (key === PRIVATE ? state.sync.file : state.sync.files[key]) || null;
const circle = key => (key ? key.split("+") : []);
const fileAt = key => (key === PRIVATE ? state.file : sharedFiles().find(s => s.key === key)?.file);
const textAt = key => serializeNotesFile(fileAt(key));
const slotKeys = () => [PRIVATE, ...sharedFiles().map(s => s.key)];
const putFile = (key, file) => (key === PRIVATE ? setPrivateFile(file) : setSharedFile(circle(key), file));

function setRec(key, value) {
  if (key === PRIVATE) setSync({ file: value });
  else setSync({ files: { ...state.sync.files, [key]: value } });
}

/** True when a file differs from the state last synced (the notes have unsynced changes). */
export function unsynced() {
  return slotKeys().some(key => rec(key) && textAt(key) !== rec(key).base);
}

// ---------- keys ----------

// A file is addressed by the server it lives on and its ID: records `{ server, id, version, base }`, keys
// in IndexedDB as `file:<server>/<id>`.
const keyName = (server, id) => `${server}/${id}`;

async function keyOf(server, id) {
  const name = keyName(server, id);
  if (!fileKeys.has(name)) {
    const key = await getSecret("file:" + name);
    if (key) fileKeys.set(name, key);
  }
  return fileKeys.get(name) || null;
}

async function rememberKey(server, id, key) {
  fileKeys.set(keyName(server, id), key);
  await setSecret("file:" + keyName(server, id), key);
}

// One time, on the first round after an update: what a device stored before files were addressed by server
// (records without `server`, keys as `file:<id>`) belongs to the default server.
async function migrateStored() {
  if (migrated) return;
  const server = ctx.defaultServer();
  const stamp = r => (r && !r.server ? { ...r, server } : r);
  const { file, files } = state.sync;
  if (file && !file.server) setSync({ file: stamp(file) });
  if (Object.values(files).some(r => !r.server)) setSync({ files: Object.fromEntries(Object.entries(files).map(([k, r]) => [k, stamp(r)])) });
  for (const r of [state.sync.file, ...Object.values(state.sync.files)]) {
    if (!r) continue;
    const old = await getSecret("file:" + r.id);
    if (!old) continue;
    if (!await getSecret("file:" + keyName(r.server, r.id))) await setSecret("file:" + keyName(r.server, r.id), old);
    await deleteSecret("file:" + r.id);
  }
  migrated = true;
}

// The verified device list of a member: its identity key must hash to its ID, the chain must check out.
function chainOf(identity, run) {
  if (!run.chains.has(identity)) {
    run.chains.set(identity, (async () => {
      if (identity === state.sync.identity) return (await ctx.chain()).devices;
      try {
        const server = contacts().find(x => x.id === identity)?.server || ctx.defaultServer();   // the member's home server
        const { identity_key: identityKey, entries } = await ctx.api(server).getIdentity(identity);
        const bytes = c.fromB64u(identityKey, 32);
        if (await c.keyId(bytes) !== identity) throw new c.ProtocolError("wrong identity key");
        return await c.verifyChain(bytes, entries);
      } catch (e) {
        if (e instanceof c.ProtocolError) throw new Error("The device list of someone in a shared file doesn't check out");
        throw e;
      }
    })());
  }
  return run.chains.get(identity);
}

// The devices a file's key is wrapped for: every active device of every member.
async function holdersFor(key, run) {
  const members = fileMembers(state.sync.identity, circle(key));
  return allKeyHolders(await Promise.all(members.map(m => chainOf(m, run))));
}

async function wrapFor(devices, key) {
  return Object.fromEntries(await Promise.all(devices.map(async d => [d.id, await c.wrapFileKey(key, d.enc)])));
}

/** Wraps the key of every file this device can read for a new device of this identity (linking). */
export async function grantKeys(deviceId, enc) {
  for (const slot of slotKeys()) {
    const r = rec(slot);
    const key = r && await keyOf(r.server, r.id);
    if (key) await ctx.api(r.server).addKeys(r.id, { [deviceId]: await c.wrapFileKey(key, enc) });
  }
}

// ---------- the round ----------

const emptyFile = () => parseNotesFile("");

// A problem with one file is kept until the others are synced; these end the round at once.
const endsRound = e => e instanceof NetworkError || (e instanceof ApiError && e.status === 401);

async function guarded(run, fn) {
  try {
    return await fn();
  } catch (e) {
    if (endsRound(e)) throw e;
    run.problems.push(e);
  }
}

/**
 * One download / merge / upload pass over all files. → { done (false when the server moved on
 * meanwhile or a file was adopted: another pass is due), again (a file changed while uploading) }.
 */
export async function filesRound() {
  await migrateStored();
  const server = ctx.home();   // the files listed here live on the home server
  const api = ctx.api(server);
  const run = { done: true, again: false, problems: [], chains: new Map() };
  const { files, quota, epoch, news } = await api.listFiles();
  const used = files.reduce((sum, f) => sum + f.size, 0);
  const { usage } = state.sync;
  if (!usage || usage.used !== used || usage.quota !== quota) setSync({ usage: { used, quota } });

  // Which file is which; a slot's server file is null when it still has to be created.
  const { privateFile, shared } = matchFiles(files, state.sync.identity);
  const slots = new Map();
  noteRestore(server, epoch, [[PRIVATE, privateFile], ...shared]);
  for (const [key, f] of shared) if (!fileAt(key)) setSharedFile(circle(key), emptyFile());
  for (const [key, f] of [[PRIVATE, privateFile], ...shared]) {
    const r = rec(key);
    if (!f && r && key === PRIVATE) throw new Error("The notes file is missing on the server");
    if (f && r && r.id !== f.id) {
      run.problems.push(new Error(key ? "A shared file is missing on the server" : "The notes file is missing on the server"));
      continue;
    }
    if (f && !r) setRec(key, { server, id: f.id, version: 0, base: "" });   // another device created it first: merge everything
    slots.set(key, f || null);
  }
  for (const s of sharedFiles()) {
    if (!slots.has(s.key) && rec(s.key)) run.problems.push(new Error("A shared file is missing on the server"));
  }
  addNewCircles(slots);

  // The server owner's news, when the list reports a new version; it may drop markers of the private file.
  if (news !== (state.sync.news?.version ?? null)) await guarded(run, () => fetchNews(api));

  // 1. Download what changed.
  const remote = new Map();
  for (const key of slots.keys()) {
    const f = slots.get(key), r = rec(key);
    if (!f) continue;
    await guarded(run, async () => {
      if (f.version < r.version) throw new Error("The server sent an older version than this device has seen");
      if (f.version > r.version || !await keyOf(r.server, r.id)) {
        ctx.busy();
        const got = await download(r.server, r.id);
        if (got.version < r.version) throw new Error("The server sent an older version than this device has seen");
        remote.set(key, got);
      }
    });
  }

  // 2. Merge them all at once, without waiting for anything.
  const displaced = [], rescued = [], me = state.sync.identity;
  for (const [key, got] of remote) {
    const localText = textAt(key);
    const local = parseNotesFile(localText);
    const merged = mergeNotesFiles(parseNotesFile(rec(key).base), local, parseNotesFile(got.text));
    if (serializeNotesFile(merged.file) !== localText) putFile(key, merged.file);
    setRec(key, { ...rec(key), version: got.version, base: got.text });
    // A note this user left that another member moved on isn't an edit to follow.
    displaced.push(...merged.displaced.filter(d => !hasLeft(d.note, me)).map(d => ({ ...d, from: key })));
    // Another member deleted a note this device has protected: it becomes a private note here, marked with its circle.
    if (key !== PRIVATE) rescued.push(...protectedDeleted(local, merged.file, isProtected, key).filter(n => !hasLeft(n, me)));
  }
  if (rescued.length) putFile(PRIVATE, adoptNotes(state.file, rescued));
  for (const d of displaced) {
    // The edit follows the note into the file it moved to, or lands in the private file when this user isn't a member there.
    const to = slotKeys().find(k => k !== d.from && fileAt(k).notes.some(n => n.id === d.note.id)) ?? PRIVATE;
    putFile(to, applyDisplaced(fileAt(to), d));
  }

  rehomeLeft();
  addNewCircles(slots);
  for (const key of slots.keys()) if (key !== PRIVATE && (slots.get(key) === null || remote.has(key) || rec(key).version === slots.get(key).version)) writeMemberName(key);
  if (remote.size) {
    // A private copy of a note that is shared again (someone was removed and added back) becomes a note of its own.
    const ids = new Set(sharedFiles().flatMap(sf => sf.file.notes.map(n => n.id)));
    const { file, renamed } = renameDuplicates(state.file, ids);
    if (renamed.length) {
      putFile(PRIVATE, file);
      setProtected(renamed.filter(r => isProtected(r.from)).map(r => r.to), true);
    }
  }

  // 3. Upload what differs from the last synced state, creating files that don't exist yet.
  // A file that moved notes away goes after the ones that may have received them, the private file last,
  // and only when those took everything: its moved markers would make the notes vanish on the user's other
  // devices before they exist in the file they moved to.
  const losers = new Set(slotKeys().filter(k => slots.get(k) && rec(k) && textAt(k) !== rec(k).base
    && movedAway(parseNotesFile(rec(k).base), fileAt(k))));
  const order = [...slots.keys()].filter(k => k !== PRIVATE && !losers.has(k))
    .concat([...losers].filter(k => k !== PRIVATE), PRIVATE).filter(k => slots.has(k));
  let blocked = false;
  for (const key of order) {
    const f = slots.get(key), r = rec(key);
    if (f && !remote.has(key) && f.version !== r.version) continue;   // its download failed
    if (blocked && losers.has(key)) continue;
    const done = await guarded(run, () => (f ? upload(key, run) : create(key, run)));
    if (!done && key !== PRIVATE) blocked = true;
  }

  if (run.done && state.sync.renew.length) await renewPending(run);
  if (run.problems.length) throw run.problems[0];
  return { done: run.done, again: run.again };
}

// A restored server (docs/server-api.md → "Admin") may hold older versions than this device has seen, or none of
// its files. Every record for it starts over, as if the files had been found on another device: the device's notes
// are merged with the server's (nothing the device holds is lost, deleted notes may come back); a file the server
// doesn't have any more is created again. `listed`: [[slot, the server's file or undefined]].
function noteRestore(server, epoch, listed) {
  const mine = key => rec(key) && rec(key).server === server;
  const versions = listed.filter(([key, f]) => f && mine(key) && rec(key).id === f.id)
    .map(([key, f]) => ({ seen: rec(key).version, served: f.version }));
  const remembered = state.sync.epochs[server];
  if (!serverRestored(remembered, epoch, versions)) return;
  const served = new Map(listed.filter(([, f]) => f).map(([key, f]) => [key, f.id]));
  for (const key of slotKeys().filter(mine)) {
    if (served.get(key) === rec(key).id) setRec(key, { ...rec(key), version: 0, base: "" });
    else if (key === PRIVATE) setSync({ file: null });
    else setSync({ files: Object.fromEntries(Object.entries(state.sync.files).filter(([k]) => k !== key)) });
  }
  setSync({ epochs: { ...state.sync.epochs, [server]: epoch } });
}

// Local shared files with notes and no file on the server yet are created in this pass.
function addNewCircles(slots) {
  for (const s of sharedFiles()) if (!slots.has(s.key) && !rec(s.key) && hasContent(s.file)) slots.set(s.key, null);
}

// Notes a member left move into the file of the remaining members (docs/file-format.md → "Leaving a shared
// note"), created on first use; only when the target file exists or all of its people are this user's contacts,
// else a member who has them as contacts does it.
function rehomeLeft() {
  const me = state.sync.identity, now = timestamp();
  const isContact = id => contacts().some(x => x.id === id && !x.pending);
  for (const s of sharedFiles()) {
    for (const note of s.file.notes.filter(n => n.left && n.left.length)) {
      const target = rehomeTarget(note, fileMembers(me, circle(s.key)), me);
      if (!target) continue;
      const toKey = circleKey(target.others);
      if (toKey !== PRIVATE && !rec(toKey) && !target.others.every(isContact)) continue;
      const moved = rehomeNote(fileAt(s.key), fileAt(toKey) || emptyFile(), note.id, now);
      putFile(s.key, moved.from);
      putFile(toKey, moved.to);
    }
  }
}

// Each member's devices keep their own display name in the shared file (docs/file-format.md → "Members").
function writeMemberName(key) {
  const me = state.sync.identity, name = state.sync.name, file = fileAt(key);
  if (!name || (file.members || []).some(m => m.id === me && m.name === name)) return;
  putFile(key, { ...file, members: [...(file.members || []).filter(m => m.id !== me), { id: me, name }] });
}

// The unencrypted news feed of the home server (docs/server-api.md → "News").
async function fetchNews(api) {
  const { version, news } = await api.news();
  const utc = t => new Date(t).toISOString();   // "…Z", which the app shows in local time
  setNewsFeed({ version, posts: news.map(({ id, created, modified, body }) => ({ id, created: utc(created), modified: utc(modified), body })) });
}

async function download(server, id) {
  ctx.moved();
  const r = await ctx.api(server).getFile(id);
  if (!r.key) throw new Error("No key for this device on the server");
  const key = await c.unwrapFileKey(r.key, ctx.keys().enc);
  const have = await keyOf(server, id);
  if (!have || c.b64u(key) !== c.b64u(have)) await rememberKey(server, id, key);   // renewed after a device was removed
  return { version: r.version, text: await c.decryptFile(key, r.ciphertext) };
}

// Uploads a changed file on top of the version this device has seen; a version conflict ends the pass early.
async function upload(key, run) {
  const r = rec(key), text = textAt(key);
  if (text === r.base) return true;
  const fileKey = await keyOf(r.server, r.id);
  if (!fileKey) throw new Error("No key for this device on the server");
  ctx.busy();
  const body = { base_version: r.version, ciphertext: await c.encryptFile(fileKey, text) };
  if (await put(key, r.server, r.id, body, text, run)) return true;
  run.done = false;
  return false;
}

// The first upload of a file: its key wrapped for every device of every member.
async function create(key, run) {
  const server = ctx.home();   // a new file lives on the home server
  ctx.busy();
  const text = textAt(key);
  const id = c.b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const fileKey = c.generateFileKey();
  const body = {
    base_version: 0, ciphertext: await c.encryptFile(fileKey, text),
    keys: await wrapFor(await holdersFor(key, run), fileKey),
  };
  if (key !== PRIVATE) body.members = fileMembers(state.sync.identity, circle(key));
  try {
    if (await put(key, server, id, body, text, run)) {
      await rememberKey(server, id, fileKey);
      return true;
    }
    run.done = false;
  } catch (e) {
    if (e instanceof ApiError && e.status === 403 && key !== PRIVATE) {
      throw new Error("Notes can only be shared with contacts. Add everyone in a shared set as a contact first.");
    }
    if (e instanceof ApiError && e.status === 409 && e.body.detail === "file exists") {
      // Another device created the file of this set first: take it over, merging everything.
      setRec(key, { server, id: e.body.id, version: 0, base: "" });
      run.done = false;
    } else throw e;
  }
  return false;
}

// PUT of `body`; false on a version conflict. The record is made once the server has the version.
async function put(key, server, id, body, text, run) {
  try {
    const { version } = await ctx.api(server).putFile(id, body);
    ctx.moved();
    setRec(key, { server, id, version, base: text });
    if (textAt(key) !== text) run.again = true;
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.body.detail !== "file exists") return false;
    throw e;
  }
}

// ---------- renewing keys ----------

/** Marks every file whose key has to be renewed (a device was removed); the next clean round does it. */
export function markRenew() {
  setSync({ renew: slotKeys().filter(rec) });
}

// A new key per file, wrapped for the devices still listed, on top of the current version. A version
// conflict leaves the file on the list for the next pass.
async function renewPending(run) {
  for (const key of [...state.sync.renew]) {
    const r = rec(key);
    if (r && fileAt(key)) {
      const renewed = await guarded(run, async () => {
        const text = textAt(key), fileKey = c.generateFileKey();
        ctx.busy();
        const body = {
          base_version: r.version, ciphertext: await c.encryptFile(fileKey, text),
          keys: await wrapFor(await holdersFor(key, run), fileKey),
        };
        if (!await put(key, r.server, r.id, body, text, run)) { run.done = false; return false; }
        await rememberKey(r.server, r.id, fileKey);
        return true;
      });
      if (!renewed) continue;
    }
    setSync({ renew: state.sync.renew.filter(k => k !== key) });
  }
}

// ---------- restoring ----------

/**
 * Restoring with the recovery key, as the recovery device: for every file of the identity reads
 * the key, wraps it for the new device and reads the text. → [{ id, members, version, key, text }]
 */
export async function readForRestore(list, recoveryEnc, deviceId, deviceEnc) {
  const api = ctx.api(ctx.home());
  const out = [];
  for (const f of list) {
    const got = await api.getFile(f.id);
    if (!got.key) continue;
    const key = await c.unwrapFileKey(got.key, recoveryEnc);
    await api.addKeys(f.id, { [deviceId]: await c.wrapFileKey(key, deviceEnc) });
    out.push({ id: f.id, members: f.members, version: got.version, key, text: await c.decryptFile(key, got.ciphertext) });
  }
  return out;
}

/** Takes over what `readForRestore` read: the private file is merged with the notes on this device
 *  (`local`) at once, the shared files are downloaded by the next round. */
export async function installRestored(read, identity, local) {
  const { privateFile, shared } = matchFiles(read.map(f => ({ ...f })), identity);
  const server = ctx.home();
  if (privateFile) {
    await rememberKey(server, privateFile.id, privateFile.key);
    setPrivateFile(mergeNotesFiles(emptyFile(), local, parseNotesFile(privateFile.text)).file);
    setRec(PRIVATE, { server, id: privateFile.id, version: privateFile.version, base: privateFile.text });
  }
  for (const [key, f] of shared) {
    await rememberKey(server, f.id, f.key);
    if (!fileAt(key)) setSharedFile(circle(key), emptyFile());
    setRec(key, { server, id: f.id, version: 0, base: "" });
  }
}

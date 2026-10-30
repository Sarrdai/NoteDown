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
import { state, setSync, setPrivateFile, setSharedFile, sharedFiles, contacts, setNewsFeed } from "../store.js";
import { parseNotesFile, serializeNotesFile, timestamp } from "../core/notes-file.js";
import { mergeNotesFiles, applyDisplaced, deletedFromShared, adoptNotes, movedAway, renameDuplicates, hasLeft, rehomeTarget, rehomeNote, moveTarget } from "../core/merge.js";
import { circleKey } from "../core/sharing.js";
import { restoredFile } from "../core/history.js";
import { matchFiles, fileMembers, allKeyHolders, hasContent, serverRestored, withSynced, dropSeenPurged, keyVerdict, legacyFileAllowed } from "../core/sync-state.js";
import * as c from "../core/crypto.js";
import { ApiError, NetworkError } from "./api.js";
import { getSecret, setSecret, deleteSecret } from "./keystore.js";
import { pinnedChain } from "./pins.js";

const PRIVATE = "";

let ctx = null;                 // { api(server), home(), defaultServer(), keys(), chain(), busy(), moved() }, from sync/client.js
const fileKeys = new Map();     // "<server>/<file ID>" → file key (32 bytes), read from the vault on first use
const keyGens = new Map();      // "<server>/<file ID>" → the generation of that key
let migrated = false;

/** Hands over what the sync client owns: the API, this device's keys, the verified own device list and the round's flags. */
export function initFiles(context) {
  ctx = context;
}

/** Forgets the file keys held in memory (the database was cleared). */
export function forgetKeys() {
  fileKeys.clear();
  keyGens.clear();
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

// The key's generation: 1 for a new file, one more with every renewal; signed into each wrap.
async function genOf(server, id) {
  const name = keyName(server, id);
  if (!keyGens.has(name)) keyGens.set(name, (await getSecret("filegen:" + name)) || 0);
  return keyGens.get(name);
}

async function rememberKey(server, id, key, gen) {
  fileKeys.set(keyName(server, id), key);
  await setSecret("file:" + keyName(server, id), key);
  keyGens.set(keyName(server, id), gen);
  await setSecret("filegen:" + keyName(server, id), gen);
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

// The verified device list of a member: its identity key must hash to its ID, the chain must check out and go on
// from what this device saw of it (sync/pins.js).
function chainOf(identity, run) {
  if (!run.chains.has(identity)) {
    run.chains.set(identity, (async () => {
      if (identity === state.sync.identity) return (await ctx.chain()).devices;
      try {
        const server = contacts().find(x => x.id === identity)?.server || ctx.defaultServer();   // the member's home server
        const { identity_key: identityKey, entries, deleted } = await ctx.api(server).getIdentity(identity);
        const bytes = c.fromB64u(identityKey, 32);
        if (await c.keyId(bytes) !== identity) throw new c.ProtocolError("wrong identity key");
        if (deleted) return new Map();   // a deleted member has no devices left to wrap keys for
        return await pinnedChain(identity, bytes, entries);
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

// A file key wrapped for a device and signed by this one: `file` the file's ID, `gen` the key's generation.
async function signedWrap(fileKey, device, file, gen) {
  return c.signWrap(await c.wrapFileKey(fileKey, device), { file, to: device.id, gen }, state.sync.device, ctx.keys().sign.privateKey);
}

async function wrapFor(devices, key, file, gen) {
  return Object.fromEntries(await Promise.all(devices.map(async d => [d.id, await signedWrap(key, d, file, gen)])));
}

// Opens a wrapped key for `keys` (a device's `{ enc, kem }`) and checks its signature: by an active or signed-out
// device of one of `members` (identity IDs; `devicesOf(member)` gives the verified devices), for file `file` and
// device `to`. A signed-out device erased its keys and the key wasn't renewed, so the wraps it made stay valid (only
// as keyVerdict allows); one removed by another device may be in the wrong hands, and its removal renewed the keys.
// → { key, signed (false for an unsigned wrap), trusted, active (the signer is still active), gen }
async function openWrap({ wrapped, file, to, members, devicesOf, keys }) {
  let signed = null;
  try { signed = c.readSignedWrap(wrapped); } catch { /* unsigned */ }
  const key = await c.unwrapFileKey(signed ? signed.wrap : wrapped, keys);
  if (!signed) return { key, signed: false, trusted: false, gen: 0 };
  for (const m of members) {
    const d = (await devicesOf(m)).get(signed.signer);
    if (d && (d.active || d.signedOut) && await c.verifyWrap(signed, { file, to }, d.sign)) return { key, signed: true, trusted: true, active: d.active, gen: signed.gen };
  }
  return { key, signed: true, trusted: false, gen: signed.gen };
}

// The key the server holds for this device, taken only as core/sync-state.js → keyVerdict allows: signed by a
// member's device, and not older than the one this device has; one a signed-out device signed is renewed at once
// (the slot's file, by the round's end). → the key to use.
async function acceptKey(server, id, slot, wrapped, members, run) {
  const got = await openWrap({ wrapped, file: id, to: state.sync.device, members, devicesOf: m => chainOf(m, run), keys: ctx.keys() });
  const have = await keyOf(server, id);
  const verdict = keyVerdict({ ...got, known: await genOf(server, id), have: !!have, same: !!have && c.b64u(got.key) === c.b64u(have) });
  if (verdict === "keep") return have;
  await rememberKey(server, id, got.key, got.gen);
  if (verdict === "renew") renewSoon([slot]);
  return got.key;
}

// A file's text, bound to the file and its version (docs/server-api.md → "Keys"), or one uploaded before files were
// bound where core/sync-state.js → legacyFileAllowed lets it in (`legacy`). → { text, bound }
async function openText(key, ciphertext, binding, legacy) {
  try {
    return { text: await c.decryptFile(key, ciphertext, binding), bound: true };
  } catch (e) {
    if (!legacy) throw new Error("A file from the server doesn't match its version; sync stopped for it");
  }
  return { text: await c.decryptLegacyFile(key, ciphertext), bound: false };
}

/** Wraps the key of every file this device can read for a new device of this identity (linking); `recipient`: its `{ enc, kem }`. */
export async function grantKeys(deviceId, recipient) {
  for (const slot of slotKeys()) {
    const r = rec(slot);
    const key = r && await keyOf(r.server, r.id);
    if (key) await ctx.api(r.server).addKeys(r.id, { [deviceId]: await signedWrap(key, { ...recipient, id: deviceId }, r.id, await genOf(r.server, r.id)) });
  }
}

// ---------- the round ----------

const emptyFile = () => parseNotesFile("");

// A problem with one file is kept until the others are synced; these end the round at once.
// 401: this device is off the list; 410 / 423: the identity is deleted / blocked (backlog #34).
const endsRound = e => e instanceof NetworkError || (e instanceof ApiError && [401, 410, 423].includes(e.status));

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
  const started = timestamp();   // what this round downloads is at least as new as this
  const { files, quota, maxMembers, epoch, news, deleted } = await api.listFiles();
  if (maxMembers !== state.sync.maxMembers) setSync({ maxMembers });
  if (deleted.join("\n") !== state.sync.deleted.join("\n")) setSync({ deleted });
  const used = files.reduce((sum, f) => sum + f.size, 0);
  const { usage } = state.sync;
  if (!usage || usage.used !== used || usage.quota !== quota) setSync({ usage: { used, quota } });

  // Which file is which; a slot's server file is null when it still has to be created.
  const { privateFile, shared } = matchFiles(files, state.sync.identity);
  const slots = new Map();
  noteRestore(server, epoch, [[PRIVATE, privateFile], ...shared]);
  const kept = [[PRIVATE, privateFile], ...shared].filter(([, f]) => f && f.history).map(([key]) => key);
  if (kept.join("\n") !== state.sync.history.join("\n")) setSync({ history: kept });
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
        const got = await download(r.server, r.id, key, run);
        if (got.version < r.version) throw new Error("The server sent an older version than this device has seen");
        remote.set(key, got);
      }
    });
  }

  // 2. Merge them all at once, without waiting for anything.
  const displaced = [], trashed = [], me = state.sync.identity, now = timestamp();
  for (const [key, got] of remote) {
    const localText = textAt(key);
    const local = parseNotesFile(localText);
    const merged = mergeNotesFiles(parseNotesFile(rec(key).base), local, parseNotesFile(got.text));
    if (serializeNotesFile(merged.file) !== localText) putFile(key, merged.file);
    setRec(key, { ...rec(key), version: got.version, base: got.text, ...(got.bound && { bound: true }) });
    // A note this user left that another member moved on isn't an edit to follow.
    displaced.push(...merged.displaced.filter(d => !hasLeft(d.note, me)).map(d => ({ ...d, from: key })));
    // A shared note deleted elsewhere goes into this user's trash, marked with its circle.
    if (key !== PRIVATE) trashed.push(...deletedFromShared(local, merged.file, key, now).filter(n => !hasLeft(n, me)));
  }
  if (trashed.length) putFile(PRIVATE, adoptNotes(state.file, trashed));
  for (const d of displaced) {
    // The edit follows the note into the file its moved marker names, and into no other file that holds a note
    // with the same id (one a member may have written, backlog #32); it lands in the private file when the marker
    // names none, this user isn't a member there, or the note isn't there yet.
    const named = d.to && d.to.includes(me) ? circleKey(d.to.filter(x => x !== me)) : null;
    const to = named !== null && named !== d.from && slotKeys().includes(named) && fileAt(named).notes.some(n => n.id === d.note.id) ? named : PRIVATE;
    putFile(to, applyDisplaced(fileAt(to), d));
  }

  rehomeLeft();
  addNewCircles(slots);
  for (const key of slots.keys()) if (key !== PRIVATE && (slots.get(key) === null || remote.has(key) || rec(key).version === slots.get(key).version)) writeMemberName(key);
  if (remote.size) {
    // A trashed note that is back in its shared file (someone undid the delete) leaves the trash — only from the file
    // it came from (`kept`), so a member can't empty the trash by writing a note with its id (backlog #32); a private copy of
    // a note that is shared again (someone was removed and added back) becomes a note of its own.
    // A purged marker goes too: a later delete of the note has to reach the trash again.
    const ids = new Set(sharedFiles().flatMap(sf => sf.file.notes.map(n => n.id)));
    const back = n => n.deleted && n.kept !== undefined && sharedFiles().some(sf => sf.key === n.kept && sf.file.notes.some(x => x.id === n.id));
    if (state.file.notes.some(back)) putFile(PRIVATE, { ...state.file, notes: state.file.notes.filter(n => !back(n)) });
    if (state.file.purged.some(m => ids.has(m.id))) putFile(PRIVATE, { ...state.file, purged: state.file.purged.filter(m => !ids.has(m.id)) });
    const { file, renamed } = renameDuplicates(state.file, ids);
    if (renamed.length) putFile(PRIVATE, file);
  }

  // This device has everything up to the round's start: it says so in the private file (once a day), and purged
  // markers all active devices have synced past go (docs/sync-and-sharing.md → "Trash").
  if (!run.problems.length) await guarded(run, async () => {
    let file = withSynced(state.file, state.sync.device, started);
    if (file.purged.length) {
      const active = [...(await chainOf(state.sync.identity, run)).values()].filter(d => d.active && d.kind === "device").map(d => d.id);
      file = dropSeenPurged(file, active);
    }
    if (file !== state.file) putFile(PRIVATE, file);
  });

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
      const moved = rehomeNote(fileAt(s.key), fileAt(toKey) || emptyFile(), note.id, now, moveTarget(circle(s.key), target.others, me));
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

async function download(server, id, slot, run) {
  ctx.moved();
  const r = await ctx.api(server).getFile(id);
  const binding = { file: id, version: r.version }, legacy = legacyFileAllowed(rec(slot));
  if (!r.key) {
    // No key for this device on the server (a server restored from a backup older than this device lost it): the
    // key this device has, if it opens the file.
    const have = await keyOf(server, id);
    const got = have && await openText(have, r.ciphertext, binding, legacy).catch(() => null);
    if (!got) throw new Error("No key for this device on the server");
    return { version: r.version, ...got };
  }
  // A new key after a renewal (a device was removed) is taken only when a member's device signed it.
  const key = await acceptKey(server, id, slot, r.key, fileMembers(state.sync.identity, circle(slot)), run);
  return { version: r.version, ...await openText(key, r.ciphertext, binding, legacy) };
}

// Uploads a changed file on top of the version this device has seen; a version conflict ends the pass early. A file
// still unbound on the server (uploaded before files were bound to their version) is uploaded once, bound.
// A restored file (`state.sync.restore`) says so, so the server pins the state it replaces.
async function upload(key, run) {
  const r = rec(key), text = textAt(key);
  const restoring = state.sync.restore.includes(key);
  const restored = () => { if (restoring) setSync({ restore: state.sync.restore.filter(k => k !== key) }); };
  if (text === r.base && r.bound) { restored(); return true; }
  const fileKey = await keyOf(r.server, r.id);
  if (!fileKey) throw new Error("No key for this device on the server");
  ctx.busy();
  const body = { base_version: r.version, ciphertext: await c.encryptFile(fileKey, text, { file: r.id, version: r.version + 1 }) };
  if (restoring) body.restore = true;
  if (await put(key, r.server, r.id, body, text, run)) { restored(); return true; }
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
    base_version: 0, ciphertext: await c.encryptFile(fileKey, text, { file: id, version: 1 }),
    keys: await wrapFor(await holdersFor(key, run), fileKey, id, 1),
  };
  if (key !== PRIVATE) body.members = fileMembers(state.sync.identity, circle(key));
  try {
    if (await put(key, server, id, body, text, run)) {
      await rememberKey(server, id, fileKey, 1);
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

// PUT of `body`; false on a version conflict. The record is made once the server has the version, which must be the
// one the ciphertext is bound to.
async function put(key, server, id, body, text, run) {
  try {
    const { version } = await ctx.api(server).putFile(id, body);
    if (version !== body.base_version + 1) throw new c.ProtocolError("The server answered with another version than it was sent");
    ctx.moved();
    setRec(key, { server, id, version, base: text, bound: true });
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

// Marks these slots' files for renewal by the next clean round (a key a signed-out device signed).
function renewSoon(slots) {
  setSync({ renew: [...new Set([...state.sync.renew, ...slots])] });
}

// A new key per file, wrapped for the devices still listed, on top of the current version. A version
// conflict leaves the file on the list for the next pass.
async function renewPending(run) {
  for (const key of [...state.sync.renew]) {
    const r = rec(key);
    if (r && fileAt(key)) {
      const renewed = await guarded(run, async () => {
        const text = textAt(key), fileKey = c.generateFileKey(), oldKey = await keyOf(r.server, r.id);
        if (!oldKey) throw new Error("No key for this device on the server");
        ctx.busy();
        const gen = await genOf(r.server, r.id) + 1;
        const body = {
          base_version: r.version, ciphertext: await c.encryptFile(fileKey, text, { file: r.id, version: r.version + 1 }),
          keys: await wrapFor(await holdersFor(key, run), fileKey, r.id, gen),
          previous_key: await c.sealPreviousKey(fileKey, oldKey),   // keeps the file's history readable
        };
        if (!await put(key, r.server, r.id, body, text, run)) { run.done = false; return false; }
        await rememberKey(r.server, r.id, fileKey, gen);
        return true;
      });
      if (!renewed) continue;
    }
    setSync({ renew: state.sync.renew.filter(k => k !== key) });
  }
}

// ---------- version history ----------

const listings = new Map();   // "<server>/<file ID>" → the last version listing (with the key chain)

function synced(slot) {
  const r = rec(slot);
  if (!r) throw new Error("This file isn't synced yet");
  return r;
}

/** The stored older states of a slot's file, newest first: [{ version, updated, replaced, size, pinned, saved }]. */
export async function listVersions(slot) {
  const r = synced(slot);
  const listing = await ctx.api(r.server).fileVersions(r.id);
  listings.set(keyName(r.server, r.id), listing);
  return listing.versions.map(({ version, updated, replaced, size, pinned, saved }) => ({ version, updated, replaced, size, pinned, saved: Boolean(saved) }));
}

/** "Back up now": the server keeps the current state of a slot's file in its history. → false when it had it already. */
export async function saveVersion(slot) {
  const r = synced(slot);
  return (await ctx.api(r.server).saveVersion(r.id)).saved;
}

// The key of generation `gen`: this device's key (the current generation), opened down the chain.
async function keyOfGeneration(r, listing, gen) {
  let key = await keyOf(r.server, r.id);
  if (!key) throw new Error("No key for this device on the server");
  for (let g = listing.key_gen - 1; g >= gen; g--) {
    const link = listing.chain.find(l => l.gen === g);
    if (!link) throw new Error("The key of this version is missing");
    key = await c.openPreviousKey(key, link.sealed);
  }
  return key;
}

/** The text of an older state of a slot's file. */
export async function readVersion(slot, version) {
  const r = synced(slot), name = keyName(r.server, r.id);
  const fresh = !listings.has(name);
  if (fresh) await listVersions(slot);
  const got = await ctx.api(r.server).fileVersion(r.id, version);
  // States from before files were bound to their version open as they are: the history only shows them.
  const open = async () => (await openText(await keyOfGeneration(r, listings.get(name), got.key_gen), got.ciphertext, { file: r.id, version }, true)).text;
  try {
    return await open();
  } catch (e) {
    if (fresh) throw e;
    // The key was renewed since the listing was read: read the chain again.
    await listVersions(slot);
    return open();
  }
}

/** Puts an older state's notes into a slot's file (`restoredFile`); the next round uploads it as a restore. */
export async function restoreVersion(slot, version) {
  const old = parseNotesFile(await readVersion(slot, version));
  putFile(slot, restoredFile(fileAt(slot), old));
  setSync({ restore: [...new Set([...state.sync.restore, slot])] });
}

// ---------- restoring ----------

/**
 * Restoring with the recovery key, as the recovery device: for every file of the identity reads the key (signed by
 * a device of its members), wraps it for the new device (signed by it) and reads the text.
 * `identity`: its ID, `own`: its verified devices; `device`: the new device's { id, keys }.
 * → [{ id, members, version, key, gen, text, bound, renew }]
 */
export async function readForRestore(list, recoveryKeys, recoveryId, identity, own, device) {
  const api = ctx.api(ctx.home());
  const chains = new Map([[identity, own]]);
  const devicesOf = async m => {
    if (!chains.has(m)) {
      const { identity_key: identityKey, entries, deleted } = await api.getIdentity(m);
      const bytes = c.fromB64u(identityKey, 32);
      if (await c.keyId(bytes) !== m) throw new Error("The device list of someone in a shared file doesn't check out");
      chains.set(m, deleted ? new Map() : await c.verifyChain(bytes, entries));
    }
    return chains.get(m);
  };
  const out = [];
  for (const f of list) {
    const got = await api.getFile(f.id);
    if (!got.key) continue;
    const opened = await openWrap({ wrapped: got.key, file: f.id, to: recoveryId, members: f.members, devicesOf, keys: recoveryKeys });
    if (!opened.trusted) throw new Error("A file's key isn't signed by a device of its members; restoring stopped");
    const verdict = keyVerdict({ ...opened, known: 0, have: false, same: false });   // "renew": a signed-out device signed it
    const wrap = await c.signWrap(await c.wrapFileKey(opened.key, c.recipientOf(device.keys)), { file: f.id, to: device.id, gen: opened.gen },
      device.id, device.keys.sign.privateKey);
    await api.addKeys(f.id, { [device.id]: wrap });
    // Merged from scratch (an empty base), so a file from before the binding can't take a note away.
    const { text, bound } = await openText(opened.key, got.ciphertext, { file: f.id, version: got.version }, true);
    out.push({ id: f.id, members: f.members, version: got.version, key: opened.key, gen: opened.gen, text, bound, renew: verdict === "renew" });
  }
  return out;
}

/** Takes over what `readForRestore` read: the private file is merged with the notes on this device
 *  (`local`) at once, the shared files are downloaded by the next round. */
export async function installRestored(read, identity, local) {
  const { privateFile, shared } = matchFiles(read.map(f => ({ ...f })), identity);
  const server = ctx.home();
  if (privateFile) {
    await rememberKey(server, privateFile.id, privateFile.key, privateFile.gen);
    setPrivateFile(mergeNotesFiles(emptyFile(), local, parseNotesFile(privateFile.text)).file);
    setRec(PRIVATE, { server, id: privateFile.id, version: privateFile.version, base: privateFile.text, ...(privateFile.bound && { bound: true }) });
  }
  for (const [key, f] of shared) {
    await rememberKey(server, f.id, f.key, f.gen);
    if (!fileAt(key)) setSharedFile(circle(key), emptyFile());
    setRec(key, { server, id: f.id, version: 0, base: "" });
  }
  // A key only a signed-out device vouched for is renewed by the first round.
  const renew = [[PRIVATE, privateFile], ...shared].filter(([, f]) => f && f.renew).map(([key]) => key);
  if (renew.length) renewSoon(renew);
}

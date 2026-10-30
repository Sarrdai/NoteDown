// Small decisions of the sync client without I/O: what a first sync keeps of
// the local notes, how the device list is shown and named, when a device counts
// as stale and a purged marker as seen, and which server file is which (the
// private file, the shared files by circle).
import { circleKey } from "./sharing.js";
import { createNote, timestamp, newId } from "./notes-file.js";

/** Id prefix of the welcome notes a first start creates (main.js). */
export const WELCOME_PREFIX = "welcome-";

/**
 * The welcome notes of a first start from app/welcome.md: a new note at each
 * line starting with "## ". The first is the newest by a minute each, so the
 * default sort (last edited) lists them in the file's order.
 */
export function welcomeNotes(text, now = new Date()) {
  const bodies = text.replace(/\r\n?/g, "\n").split(/^(?=## )/m).map(b => b.trim()).filter(Boolean);
  return bodies.map((body, i) => createNote(body, timestamp(new Date(now.getTime() - i * 60000)), WELCOME_PREFIX + newId()));
}

const untouchedWelcome = n => n.id.startsWith(WELCOME_PREFIX) && n.created === n.modified;

/**
 * The file without the welcome notes that were never edited (closed or not),
 * for linking a device: the synced notes bring their own. Same object when
 * there are none.
 */
export function withoutUntouchedWelcome(file) {
  const notes = file.notes.filter(n => !untouchedWelcome(n));
  return notes.length === file.notes.length ? file : { ...file, notes };
}

/**
 * Rows for the device list: the active devices of a verified chain (a Map
 * from crypto.verifyChain), this device first. `names` are the private file's
 * device markers ([{ id, name?, title?, synced? }]). `label` is what the row shows: the name the user gave the
 * device (`title`), else the one it suggested (`name`), else "This device" for this device and the others
 * numbered in the order they were added; `hint` is the suggested name under a given one. `synced`: when the device last synced.
 */
export function deviceRows(devices, ownId, names = []) {
  const marker = new Map(names.map(d => [d.id, d]));
  const all = [...devices.values()].filter(d => d.kind === "device");
  const rows = all.map((d, i) => {
    const { name, title, synced } = marker.get(d.id) || {};
    return {
      id: d.id, own: d.id === ownId, named: Boolean(title || name), ...(synced && { synced }), ...(title && { title }), ...(title && name && { hint: name }),
      label: title || name || (d.id === ownId ? "This device" : `Device ${i + 1}`), active: d.active,
    };
  });
  return rows.filter(r => r.active).sort((a, b) => b.own - a.own).map(({ active, ...r }) => r);
}

/** The private file with `name` (the suggested one) set for device `id`, its given name and sync time kept
 *  (none: the device's marker removed, e.g. when the device is removed). */
export function withDeviceName(file, id, name) {
  const devices = (file.devices || []).filter(d => d.id !== id);
  const { title, synced } = (file.devices || []).find(d => d.id === id) || {};
  return { ...file, devices: name ? [...devices, { id, name, ...(title && { title }), ...(synced && { synced }) }] : devices };
}

/** The private file with the name the user gave device `id` set to `title` (trimmed; empty: back to the suggested name). */
export function withDeviceTitle(file, id, title) {
  const devices = (file.devices || []).filter(d => d.id !== id);
  const { name, synced } = (file.devices || []).find(d => d.id === id) || {};
  const next = { id, ...(name && { name }), ...(title?.trim() && { title: title.trim() }), ...(synced && { synced }) };
  return { ...file, devices: next.name || next.title || next.synced ? [...devices, next] : devices };
}

/** Days without a sync after which a device is shown as stale, with the suggestion to remove it. */
export const STALE_DAYS = 90;

/** Whole days since `synced` (a file timestamp) at `now` (ms); undefined when the device never reported one. */
export function daysSince(synced, now = Date.now()) {
  return synced ? Math.floor((now - Date.parse(synced)) / 86400000) : undefined;
}

/** The private file with device `id`'s `synced` set to `start` (the start of a complete sync round); unchanged
 *  when it already holds a time of the same day, so the file changes at most once a day per device. */
export function withSynced(file, id, start) {
  const devices = file.devices || [];
  const own = devices.find(d => d.id === id);
  if (own?.synced?.slice(0, 10) === start.slice(0, 10)) return file;
  return { ...file, devices: [...devices.filter(d => d.id !== id), { ...own, id, synced: start }] };
}

/** The private file without the purged markers every device in `deviceIds` (the active devices) has synced past:
 *  none of them can still find the note in a shared file and put it into the trash again. */
export function dropSeenPurged(file, deviceIds) {
  const synced = new Map((file.devices || []).map(d => [d.id, d.synced]));
  const seen = m => deviceIds.every(id => synced.get(id) > m.purged);
  return (file.purged || []).some(seen) ? { ...file, purged: file.purged.filter(m => !seen(m)) } : file;
}

/** The devices a file key is wrapped for: every active device, the recovery device included. */
export function keyHolders(devices) {
  return [...devices.values()].filter(d => d.active);
}

/** The devices every member's file key is wrapped for: the active devices (recovery devices included)
 *  of each verified device list in `chains` (an array of Maps from crypto.verifyChain). */
export function allKeyHolders(chains) {
  return chains.flatMap(keyHolders);
}

/** The member ids of a shared file as the server lists them: the user and the circle's other
 *  people (`circle`: their ids, the circleKey's parts), sorted. The private file is the user alone. */
export function fileMembers(identity, circle) {
  return [identity, ...circle].sort();
}

/**
 * Sorts the server's file list (`files`: { id, members, ... }, each with the user among its members)
 * into the private file (only the user is a member) and the shared files by circleKey (the members
 * without the user, as `state.shared` keys them).
 * → { privateFile (or undefined), shared: Map circleKey → file }
 */
export function matchFiles(files, identity) {
  const shared = new Map();
  let privateFile;
  for (const f of files) {
    const others = f.members.filter(m => m !== identity);
    if (!others.length) privateFile = f;
    else shared.set(circleKey(others), f);
  }
  return { privateFile, shared };
}

/**
 * Whether the server went back in time (a restored backup, docs/server-api.md → "Admin"): the epoch it reports
 * (`epoch`, null until the first restore) differs from the one this device last saw (`remembered`; none yet counts
 * as "never restored"), or it serves an older version of a file than this device has seen (`versions`: [{ seen,
 * served }] per file with a record), which also catches a restore without a new epoch (the database host's own
 * point-in-time recovery). The device then merges everything again and keeps its notes.
 */
export function serverRestored(remembered, epoch, versions) {
  return (remembered || "") !== (epoch || "") || versions.some(v => v.served < v.seen);
}

/** True when a file has anything worth keeping on the server (an empty circle left behind by an undo needs none). */
export const hasContent = file => file.notes.length > 0 || Boolean(file.order);

const MB = 1024 * 1024;
const mb = bytes => String(Math.round(bytes / MB * 10) / 10);

/**
 * The sync storage bar from `{ used, quota }` in bytes: the text under it,
 * the filled share (0..1) and the level ("ok", "warn" from 80 %, "full" at 100 %).
 * `refused`: the server just refused an upload for the quota, so the bar is full
 * whatever the numbers say (the new file wouldn't fit).
 */
export function storageUsage({ used, quota }, refused = false) {
  const fraction = refused || !(quota > 0) ? 1 : Math.min(used / quota, 1);
  const amount = used < 0.05 * MB ? "< 0.1" : mb(used);
  return {
    text: `${amount} MB of ${mb(quota)} MB used`,
    fraction,
    percent: Math.round(fraction * 100),
    level: fraction >= 1 ? "full" : fraction >= 0.8 ? "warn" : "ok",
  };
}

export const POLL_MIN_MS = 5000;
export const POLL_MAX_MS = 30000;

/**
 * The delay before the next poll round: back to the minimum when the last
 * round moved something (or the user or the app woke it), otherwise doubled
 * up to the maximum: 5, 10, 20, 30, 30, ... s.
 */
export function nextPollDelay(current, changed) {
  return changed ? POLL_MIN_MS : Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, current * 2));
}

/**
 * A file limit the server refused an upload for (413 `{detail, members}`, backlog #27): a shared file
 * counts for every member, so the one over the limit may be someone else. → `{ own }` when this
 * identity (`me`) is over it (or the server named nobody), else `{ message }` naming the others;
 * `nameOf(id)` gives a member's name (empty: unknown). null for any other answer.
 */
export function limitRefusal(status, body, me, nameOf) {
  const kind = { "storage quota exceeded": "storage", "too many files": "files" }[body?.detail];
  if (status !== 413 || !kind) return null;
  const members = Array.isArray(body.members) ? body.members : [];
  if (!members.length || members.includes(me)) return { own: true, kind };
  const names = members.map(id => nameOf(id) || "a member");
  const who = names.length > 1 ? names.slice(0, -1).join(", ") + " and " + names.at(-1) : names[0];
  return { own: false, kind, message: kind === "storage"
    ? `The sync storage of ${who} is full, so this shared note can't sync.`
    : `${who[0].toUpperCase() + who.slice(1)} ${names.length > 1 ? "have" : "has"} too many synced files, so this shared note can't sync.` };
}


/** The sync status while the server's owner blocks this identity (backlog #34); `until` is the block's end
 *  (ISO) or null for none. Dates in the user's time zone unless `timeZone` is given (tests). */
export function blockedMessage(until, timeZone) {
  if (!until) return "Sync is blocked by the server's owner.";
  const date = new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", year: "numeric" }).format(new Date(until));
  return `Sync is blocked by the server's owner until ${date}.`;
}

/**
 * The card above the notes when sync stopped working on this device (user request 2026-10-16: so nobody types
 * on here and wonders why nothing syncs), from the sync state: → null or { kind, title, sub, closable }.
 * "removed": this device was taken off the device list; "deleted": the identity's sync data was deleted (both:
 * sync is off, the notes stayed); "outdated": the server no longer serves this app version (backlog #51; `native`:
 * the Android app, which is installed anew, else the web app, which reloads); "blocked": the server's owner blocks
 * the identity (sync resumes after it).
 */
export function syncNotice(sync, timeZone, native = false) {
  if (!sync.enabled && sync.ended === "removed") {
    return { kind: "removed", title: "This device was removed from sync", sub: "Changes you make here stay on this device only. Link it again to sync.", closable: true };
  }
  if (!sync.enabled && sync.ended === "deleted") {
    return { kind: "deleted", title: "Your sync data was deleted", sub: "Your notes stay on this device only. Turn on sync to start again.", closable: true };
  }
  if (sync.enabled && sync.outdated) {
    return { kind: "outdated", title: "Update NoteDown to keep syncing", sub: native
      ? "This version is too old for the sync server. Install the current app; your changes here are kept and sync then."
      : "This version is too old for the sync server. Reload the page to get the current one; your changes here are kept and sync then.", closable: false };
  }
  if (sync.enabled && sync.blocked) {
    return { kind: "blocked", title: blockedMessage(sync.blocked.until, timeZone), sub: "Changes you make here are kept and sync once the block ends.", closable: false };
  }
  return null;
}

/**
 * The private file a device keeps once it was removed from sync or its identity was deleted (backlog #34): its own
 * notes and trash plus every note of the shared files it hasn't left (`me`: the identity ID), all
 * private now; nothing tied to the identity — devices, contacts, moved and purged markers, which circle
 * a trashed note came from. The news state, the folder sources and the custom order stay.
 */
export function detachedFile(file, shared, me) {
  const plain = ({ kept, left, ...n }) => n;
  const fromShared = shared.flatMap(s => s.file.notes.filter(n => !(n.left || []).includes(me)));
  return {
    preamble: file.preamble || "", notes: [...file.notes, ...fromShared].map(plain), moved: [], purged: [],
    devices: [], contacts: [], members: [], news: file.news || [], sources: file.sources || [], order: file.order || null,
  };
}

/**
 * What a device does with a file key the server hands it (docs/sync-and-sharing.md → "Keys"): each
 * wrapped key is signed by the device that made it, with the key's generation, which goes up with every renewal.
 * `signed`: the wrap carries a signature; `trusted`: it checks out against an active or signed-out device of one of
 * the file's members; `active`: that device is still active; `gen`: its generation; `known`: the highest generation
 * this device took for the file (0: none); `have`: this device has a key for the file; `same`: the offered key is that key.
 * → "keep" (nothing new), "take" (remember the offered key), "renew" (remember it, then renew it at once) or throws:
 * a server can't swap in a key of its own, nor an older one a removed device still knows. A device that signed out
 * may have left a copy behind (security review H4): the wraps it made stay valid, but only a device without a key
 * (restoring after the last device signed out) takes a key from it, and renews that key right away.
 */
export function keyVerdict({ signed, trusted, gen, known, have, same, active = true }) {
  if (!signed || !trusted) throw new Error("A file's key isn't signed by a device of its members; sync stopped for it");
  if (have && same && gen <= known) return "keep";
  if (gen < known || (gen === known && have)) throw new Error("The server offered an outdated key for a file; sync stopped for it");
  if (!active && have) throw new Error("A file's key is signed by a device that signed out; sync stopped for it");
  return active ? "take" : "renew";
}

/**
 * Whether a file uploaded before files were bound to their version (security review H2) may be opened for the
 * record `{ version, base, bound }` of it: only while this device never saw a bound version of the file, or when
 * it merges from scratch (empty base: a file found on another device, a restored server), where an older state
 * can't take a note away. Otherwise a server could hand out an old state as a newer version.
 */
export const legacyFileAllowed = record => !record.bound || !record.base;

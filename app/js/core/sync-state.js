// Small decisions of the sync client without I/O: what a first sync keeps of
// the local notes, how the device list is shown and named, when a device counts
// as stale and a purged marker as seen, and which server file is which (the
// private file, the shared files by circle).
import { circleKey } from "./sharing.js";

/** Id prefix of the welcome note a first start creates (main.js). */
export const WELCOME_PREFIX = "welcome-";

/** True when a parsed file holds nothing but the welcome note, never edited. */
export function onlyUntouchedWelcome(file) {
  return file.notes.length === 1 && !file.moved.length && file.notes[0].id.startsWith(WELCOME_PREFIX)
    && file.notes[0].status === "open" && file.notes[0].created === file.notes[0].modified;
}

/**
 * Rows for the device list: the active devices of a verified chain (a Map
 * from crypto.verifyChain), this device first. `names` are the private file's
 * device markers ([{ id, name?, synced? }]); without a name, this device is "This device"
 * and the others are numbered in the order they were added. `synced`: when the device last synced.
 */
export function deviceRows(devices, ownId, names = []) {
  const named = new Map(names.filter(d => d.name).map(d => [d.id, d.name]));
  const synced = new Map(names.filter(d => d.synced).map(d => [d.id, d.synced]));
  const all = [...devices.values()].filter(d => d.kind === "device");
  const rows = all.map((d, i) => ({ id: d.id, own: d.id === ownId, named: named.has(d.id), ...(synced.has(d.id) && { synced: synced.get(d.id) }),
    label: named.get(d.id) || (d.id === ownId ? "This device" : `Device ${i + 1}`), active: d.active }));
  return rows.filter(r => r.active).sort((a, b) => b.own - a.own).map(({ active, ...r }) => r);
}

/** The private file with `name` set for device `id` (none: the name removed). */
export function withDeviceName(file, id, name) {
  const devices = (file.devices || []).filter(d => d.id !== id);
  const synced = (file.devices || []).find(d => d.id === id)?.synced;
  return { ...file, devices: name ? [...devices, { id, name, ...(synced && { synced }) }] : devices };
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


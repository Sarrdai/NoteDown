// Small decisions of the sync client without I/O: what a first sync keeps of
// the local notes, and how the device list is shown and named.

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
 * device names ([{ id, name }]); without one, this device is "This device"
 * and the others are numbered in the order they were added.
 */
export function deviceRows(devices, ownId, names = []) {
  const named = new Map(names.map(d => [d.id, d.name]));
  const all = [...devices.values()].filter(d => d.kind === "device");
  const rows = all.map((d, i) => ({ id: d.id, own: d.id === ownId, named: named.has(d.id),
    label: named.get(d.id) || (d.id === ownId ? "This device" : `Device ${i + 1}`), active: d.active }));
  return rows.filter(r => r.active).sort((a, b) => b.own - a.own).map(({ active, ...r }) => r);
}

/** The private file with `name` set for device `id` (none: the name removed). */
export function withDeviceName(file, id, name) {
  const devices = (file.devices || []).filter(d => d.id !== id);
  return { ...file, devices: name ? [...devices, { id, name }] : devices };
}

/** The devices a file key is wrapped for: every active device, the recovery device included. */
export function keyHolders(devices) {
  return [...devices.values()].filter(d => d.active);
}

const MB = 1024 * 1024;
const mb = bytes => String(Math.round(bytes / MB * 10) / 10);

/**
 * The sync storage bar from `{ used, quota }` in bytes: the text under it,
 * the filled share (0..1) and the level ("ok", "warn" from 80 %, "full" at 100 %).
 */
export function storageUsage({ used, quota }) {
  const fraction = quota > 0 ? Math.min(used / quota, 1) : 1;
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

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

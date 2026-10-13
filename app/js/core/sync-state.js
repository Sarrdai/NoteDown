// Small decisions of the sync client without I/O: what a first sync keeps of
// the local notes, and how the device list is shown.

/** Id prefix of the welcome note a first start creates (main.js). */
export const WELCOME_PREFIX = "welcome-";

/** True when a parsed file holds nothing but the welcome note, never edited. */
export function onlyUntouchedWelcome(file) {
  return file.notes.length === 1 && !file.moved.length && file.notes[0].id.startsWith(WELCOME_PREFIX)
    && file.notes[0].status === "open" && file.notes[0].created === file.notes[0].modified;
}

/**
 * Rows for the device list: the active devices of a verified chain (a Map
 * from crypto.verifyChain), this device first. Devices have no names on the
 * server, so the others are numbered in the order they were added.
 */
export function deviceRows(devices, ownId) {
  const all = [...devices.values()].filter(d => d.kind === "device");
  const rows = all.map((d, i) => ({ id: d.id, own: d.id === ownId, label: d.id === ownId ? "This device" : `Device ${i + 1}`, active: d.active }));
  return rows.filter(r => r.active).sort((a, b) => b.own - a.own).map(({ active, ...r }) => r);
}

/** The devices a file key is wrapped for: every active device, the recovery device included. */
export function keyHolders(devices) {
  return [...devices.values()].filter(d => d.active);
}

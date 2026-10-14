// Prototype only: loads app/sample/notes.md, the one source of sample
// content (CLAUDE.md), and app/sample/sharing.json (who the sample user is,
// their devices and contacts, which notes are shared). The dates of the
// notes are shifted by whole days so the newest created / modified / closed
// date falls on today — "due today", "overdue" and the archive count stay
// meaningful whenever the prototype is opened.
import { today, addDays } from "./ui/format.js";
import { parseNotesFile, timestamp } from "./core/notes-file.js";
import { splitIntoCircles, generateRecoveryKey, nextColor, circleKey } from "./core/sharing.js";

export async function loadSample() {
  const text = await (await fetch(new URL("../sample/notes.md", import.meta.url))).text();
  const markers = text.match(/^<!-- note .*-->$/gm) || [];
  const days = markers.flatMap(m => [...m.matchAll(/(?:created|modified|closed)=(\d{4}-\d{2}-\d{2})/g)].map(x => x[1])).sort();
  const newest = days[days.length - 1];
  if (!newest) return text;
  const shift = Math.round((Date.parse(today()) - Date.parse(newest)) / 86400000);
  return text.replace(/^<!-- note .*-->$/gm, line => line.replace(/\d{4}-\d{2}-\d{2}/g, d => addDays(d, shift)));
}

let sharing = null;

/** The sample identity: name, devices, contacts, shared notes, scan suggestion. */
export function loadSharingSample() {
  sharing ||= fetch(new URL("../sample/sharing.json", import.meta.url)).then(r => r.json());
  return sharing;
}

// A sample contact: scanned in person = verified, added by link = not (backlog #4).
const contactOf = ({ via, ...c }, color) => ({ ...c, color, ...(via === "scan" && { verified: timestamp() }) });

/**
 * The full sample state for the store (`replaceFiles`): the sample notes and,
 * with `sync`, the sample identity with its contacts and shared files.
 */
export async function loadSampleState({ sync = true } = {}) {
  const file = parseNotesFile(await loadSample());
  if (!sync) return { file, shared: [], sync: { simulated: true } };
  const s = await loadSharingSample();
  const split = splitIntoCircles(file, s.shared);
  // A shared order a member set (backlog #25), simulated until milestone 2.
  for (const g of s.shared.filter(g => g.order)) {
    split.shared.find(c => circleKey(c.members) === circleKey(g.members)).file.order = { ids: [...g.order], modified: timestamp() };
  }
  return {
    file: split.file,
    shared: split.shared,
    sync: {
      enabled: true, simulated: true, name: s.name, recoveryKey: generateRecoveryKey(),
      devices: [...s.devices], usage: { ...s.storage }, contacts: s.contacts.reduce((list, c) => [...list, contactOf(c, nextColor(list))], []),
      offline: false, status: "synced", lastSync: Date.now(),
    },
  };
}

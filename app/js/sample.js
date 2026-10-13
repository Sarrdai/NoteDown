// Prototype only: loads app/sample/notes.md, the one source of sample
// content (CLAUDE.md). Its dates are shifted by whole days so the newest
// created / modified / closed date falls on today — "due today", "overdue"
// and the archive count stay meaningful whenever the prototype is opened.
import { today, addDays } from "./ui/format.js";

export async function loadSample() {
  const text = await (await fetch(new URL("../sample/notes.md", import.meta.url))).text();
  const markers = text.match(/^<!-- note .*-->$/gm) || [];
  const days = markers.flatMap(m => [...m.matchAll(/(?:created|modified|closed)=(\d{4}-\d{2}-\d{2})/g)].map(x => x[1])).sort();
  const newest = days[days.length - 1];
  if (!newest) return text;
  const shift = Math.round((Date.parse(today()) - Date.parse(newest)) / 86400000);
  return text.replace(/^<!-- note .*-->$/gm, line => line.replace(/\d{4}-\d{2}-\d{2}/g, d => addDays(d, shift)));
}

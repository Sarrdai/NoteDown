// Google Keep → NoteDown: reads the notes of a Google Takeout export (one
// JSON file per note under Takeout/Keep/) and turns them into NoteDown notes
// (docs/requirements.md → "Import from Google Keep"). Title → "## Title",
// text as it is, checklists → task checkboxes, labels → a last line of
// #labels, the dates kept; archived → closed, pinned → permanent; the note
// color → the matching NoteDown color (core/look.js). Images, recordings and
// drawings, collaborators and reminders don't come along; notes in Keep's
// trash are left out. A note keeps where it came from (`keep=`, see keepOrigin)
// so a second import of the same export can recognise it.
import { zipEntries } from "./zip.js";
import { createNote, timestamp, newId } from "./notes-file.js";
import { toLabel } from "./labels.js";
import { keepColor } from "./look.js";

const KIND = [["image/", "image"], ["audio/", "recording"]];

/** What identifies a Keep note across exports: its creation time (µs) and the file's base name,
 *  "<usec>~<encoded name>" (the marker value of `keep=`); null without a creation time. */
export function keepOrigin(json, file = "") {
  const created = Number(json.createdTimestampUsec);
  if (!(created > 0)) return null;
  return `${created}~${encodeURIComponent(file.split("/").pop())}`;
}

/** One Keep note (its parsed JSON) as the preview shows it; null when the JSON is no Keep note. */
export function keepNote(json, file = "") {
  if (!json || typeof json !== "object" || !("textContent" in json || "listContent" in json || "title" in json)) return null;
  const title = String(json.title || "").trim();
  const lines = [];
  if (title) lines.push("## " + title.replace(/\n+/g, " "));
  const text = String(json.textContent || "").replace(/\r\n?/g, "\n").trim();
  if (text) lines.push(text);
  for (const item of json.listContent || []) {
    const t = String(item.text || "").replace(/\s*\n\s*/g, " ").trim();
    if (t) lines.push(`- [${item.isChecked ? "x" : " "}] ${t}`);
  }
  const labels = (json.labels || []).map(l => toLabel(String(l.name || ""))).filter(Boolean);
  const hasText = lines.length > 0;
  if (labels.length) lines.push((hasText ? "\n" : "") + labels.map(l => "#" + l).join(" "));
  const dropped = {};
  for (const a of json.attachments || []) {
    const kind = KIND.find(([prefix]) => String(a.mimetype || "").startsWith(prefix))?.[1] || "file";
    // Keep stores drawings as images; their file name says "drawing" in some exports.
    const k = kind === "image" && /drawing/i.test(a.filePath || "") ? "drawing" : kind;
    dropped[k] = (dropped[k] || 0) + 1;
  }
  const usec = v => (Number(v) > 0 ? timestamp(new Date(Number(v) / 1000)) : null);
  const modified = usec(json.userEditedTimestampUsec) || usec(json.createdTimestampUsec) || timestamp();
  return {
    file,
    keep: keepOrigin(json, file),
    body: lines.join("\n"),
    hasText,
    status: json.isArchived ? "closed" : json.isPinned ? "permanent" : "open",
    created: usec(json.createdTimestampUsec) || modified,
    modified,
    color: keepColor(json.color),
    trashed: !!json.isTrashed,
    shared: (json.sharees || []).some(s => !s.isOwner),
    dropped,
  };
}

/** The Keep notes of a parsed export, [{ name, text }] → { notes, trashed } —
 *  newest first; `trashed` counts the notes in Keep's trash, which are left out. */
export function keepNotes(files) {
  const all = [];
  for (const f of files) {
    if (!/\.json$/i.test(f.name)) continue;
    let json;
    try { json = JSON.parse(f.text); } catch { continue; }
    const n = keepNote(json, f.name);
    if (n) all.push(n);
  }
  const notes = all.filter(n => !n.trashed).sort((a, b) => b.modified.localeCompare(a.modified));
  return { notes, trashed: all.length - notes.length };
}

/** Reads a Takeout ZIP (Uint8Array): the JSON files of its Keep folder (any folder for an export of Keep alone). */
export async function readKeepZip(bytes) {
  const entries = zipEntries(bytes).filter(e => /\.json$/i.test(e.name));
  const inKeep = entries.filter(e => /(^|\/)Keep\//.test(e.name));
  const dec = new TextDecoder();
  const files = await Promise.all((inKeep.length ? inKeep : entries).map(async e => ({ name: e.name, text: dec.decode(await e.read()) })));
  return keepNotes(files);
}

/** A NoteDown note for an imported Keep note (only one with text can be imported). */
export function toNoteDown(k) {
  const n = createNote(k.body, k.created, newId());
  n.modified = k.modified;
  n.status = k.status;
  if (k.status === "closed") n.closed = k.modified;
  if (k.color) n.color = k.color;
  if (k.keep) n.keep = k.keep;
  return n;
}

/** What a note leaves behind, for the preview: "1 image, 2 recordings". */
export function droppedText(dropped) {
  return Object.entries(dropped).map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`).join(", ");
}

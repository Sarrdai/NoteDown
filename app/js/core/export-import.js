// A NoteDown export (core/export.js) read back for the import page
// (docs/requirements.md → "Import"): one Markdown file, or a ZIP of them
// ("All files"). With markers the notes come back as they were; without,
// the file has no note boundaries left, so it is cut at the level-2 headings
// ("## Title", as notes start in the app) into new notes. Also: which
// previewed notes already exist.
import { parseNotesFile, newId, timestamp, createNote } from "./notes-file.js";
import { zipEntries } from "./zip.js";

const ARCHIVE_TAIL = /\n+---\n+\*\*[^*\n]+\*\*\s*$/;   // the rule and label that open the archive group
const CONTENTS = /^\*\*Contents\*\*\n[\s\S]*?\n---\n+/;   // the table of contents on top

/** One export file's text → [{ file, body, hasText, status, created, modified, color, … }] as the preview shows them;
 *  `id` is set for notes that had a marker. Deleted notes (trash) and bodyless markers are left out. */
export function exportNotes(text, file = "") {
  const clean = text.replace(/\r\n?/g, "\n");
  if (/^<!-- note /m.test(clean)) {
    const { notes } = parseNotesFile(clean);
    return notes.filter(n => !n.deleted && n.body.trim()).map(n => {
      const body = n.body.replace(ARCHIVE_TAIL, "").trim();
      return { ...n, body, file, hasText: true, shared: false, dropped: {}, fromExport: true };
    }).filter(n => n.body);
  }
  const body = clean.replace(CONTENTS, "").trim();
  const now = timestamp();
  const archiveAt = body.search(/(^|\n)---\n+\*\*[^*\n]+\*\*\n/);
  const parts = [[archiveAt < 0 ? body : body.slice(0, archiveAt), "open"]];
  if (archiveAt >= 0) parts.push([body.slice(archiveAt).replace(/^\s*---\n+\*\*[^*\n]+\*\*\n+/, ""), "closed"]);
  const out = [];
  for (const [chunk, status] of parts) {
    for (const piece of chunk.split(/\n(?=## )/)) {
      const b = piece.trim();
      if (b) out.push({ file, body: b, hasText: true, status, created: now, modified: now, shared: false, dropped: {}, fromExport: true });
    }
  }
  return out;
}

/** The notes of an export file (.md) or ZIP (bytes), newest first as far as the notes carry a date. */
export async function readExport(name, bytes) {
  const dec = new TextDecoder();
  let files;
  if (/\.zip$/i.test(name)) {
    const entries = zipEntries(bytes).filter(e => /\.md$/i.test(e.name));
    files = await Promise.all(entries.map(async e => ({ name: e.name, text: dec.decode(await e.read()) })));
  } else {
    files = [{ name, text: dec.decode(bytes) }];
  }
  const notes = files.flatMap(f => exportNotes(f.text, f.name));
  return { notes: notes.sort((a, b) => b.modified.localeCompare(a.modified)), trashed: 0 };
}

/** Sets `exists` on each previewed note: a NoteDown note whose id is in the notes already there, a Keep note whose
 *  `keep` origin is. `existing` is every note of every file on this device (trash included). */
export function markExisting(notes, existing) {
  const ids = new Set(existing.map(n => n.id));
  const origins = new Set(existing.map(n => n.keep).filter(Boolean));
  for (const n of notes) n.exists = n.fromExport ? !!n.id && ids.has(n.id) : !!n.keep && origins.has(n.keep);
  return notes;
}

/** The NoteDown note for a previewed export note. It keeps its id, dates, status, due date and look unless the id
 *  is `taken` (already here, or twice in the file): then it is a copy with a new id. Existing notes are never overwritten. */
export function exportToNoteDown(e, taken) {
  const id = e.id && !taken.has(e.id) ? e.id : newId();
  taken.add(id);
  const n = createNote(e.body, e.created, id);
  n.modified = e.modified;
  n.status = e.status;
  if (e.closed) n.closed = e.closed;
  if (e.due) n.due = e.due;
  if (e.color) n.color = e.color;
  if (e.decor) n.decor = e.decor;
  if (e.texture) n.texture = e.texture;
  return n;
}

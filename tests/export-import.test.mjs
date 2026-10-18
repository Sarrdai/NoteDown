// Reading a NoteDown export back (app/js/core/export-import.js) and recognising notes already there. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNotesFile } from "../app/js/core/notes-file.js";
import { exportMarkdown, zipFiles } from "../app/js/core/export.js";
import { exportNotes, readExport, markExisting, exportToNoteDown } from "../app/js/core/export-import.js";
import { keepNote, toNoteDown } from "../app/js/core/keep-import.js";

const { notes } = parseNotesFile(readFileSync(new URL("../app/sample/notes.md", import.meta.url), "utf8"));
const byId = id => notes.find(n => n.id === id);
const items = (...ids) => ids.map(id => ({ note: byId(id), text: byId(id).body }));
const sampleKeep = JSON.parse(readFileSync(new URL("../app/sample/keep.json", import.meta.url), "utf8")).files;

test("export import: markers restore id, dates, status, color, due date", () => {
  const md = exportMarkdown([{ items: items("s01", "s03") }], { metadata: true, toc: true });
  const back = exportNotes(md);
  assert.deepEqual(back.map(n => n.id), ["s01", "s03"]);
  assert.equal(back[1].color, "blue");
  assert.equal(back[1].due, "2026-10-17");
  assert.equal(back[1].modified, byId("s03").modified);
  assert.equal(back[1].body, byId("s03").body);
});

test("export import: the archive label does not stay in the last open note", () => {
  const closed = notes.find(n => n.status === "closed");
  const md = exportMarkdown([{ items: items("s01") }, { label: "Archive", items: [{ note: closed, text: closed.body }] }], { metadata: true });
  const back = exportNotes(md);
  assert.equal(back[0].body, byId("s01").body);
  assert.equal(back[1].status, "closed");
});

test("export import: without markers the file is cut at ## headings into new notes", () => {
  const closed = notes.find(n => n.status === "closed");
  const md = exportMarkdown([{ items: items("s01", "s04") }, { label: "Archive", items: [{ note: closed, text: closed.body }] }], { toc: true });
  const back = exportNotes(md);
  assert.deepEqual(back.map(n => n.body.split("\n")[0]), [byId("s01").body.split("\n")[0], byId("s04").body.split("\n")[0], closed.body.split("\n")[0]]);
  assert.deepEqual(back.map(n => n.status), ["open", "open", "closed"]);
  assert.ok(back.every(n => !n.id && n.fromExport));
});

test("export import: reads a ZIP of several files", async () => {
  const zip = zipFiles([
    { name: "Private.md", text: exportMarkdown([{ items: items("s01") }], { metadata: true }) },
    { name: "Lea.md", text: exportMarkdown([{ items: items("s04") }], { metadata: true }) },
  ]);
  const r = await readExport("NoteDown-2026-10-18.zip", zip);
  assert.deepEqual(r.notes.map(n => n.id).sort(), ["s01", "s04"]);
});

test("recognising: NoteDown notes by id, Keep notes by file name and creation time", () => {
  const exp = exportNotes(exportMarkdown([{ items: items("s01", "s04") }], { metadata: true }));
  markExisting(exp, [{ id: "s01" }]);
  assert.deepEqual(exp.map(n => n.exists), [true, false]);

  const f = sampleKeep[0];
  const k = keepNote(f.json, f.name);
  assert.match(k.keep, /^\d+~Weekly%20groceries\.json$/);
  const stored = toNoteDown(k);
  assert.equal(stored.keep, k.keep);
  // The same note from another export (another folder) is recognised; the marker keeps `keep` through the file format.
  const reread = parseNotesFile(`<!-- note id=${stored.id} status=open created=${stored.created} modified=${stored.modified} keep=${stored.keep} -->\nx`).notes;
  const again = keepNote(f.json, "Takeout/Keep/Weekly groceries.json");
  markExisting([again], reread);
  assert.equal(again.exists, true);
  const other = keepNote(sampleKeep[1].json, sampleKeep[1].name);
  markExisting([other], reread);
  assert.equal(other.exists, false);
});

test("export import: an id that exists (or repeats) becomes a copy with a new id", () => {
  const [e] = exportNotes(exportMarkdown([{ items: items("s01") }], { metadata: true }));
  const taken = new Set(["s01"]);
  const copy = exportToNoteDown(e, taken);
  assert.notEqual(copy.id, "s01");
  const fresh = exportToNoteDown(e, new Set());
  assert.equal(fresh.id, "s01");
  assert.equal(fresh.modified, e.modified);
});

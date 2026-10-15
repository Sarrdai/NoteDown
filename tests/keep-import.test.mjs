// Unit tests for reading ZIP archives (app/js/core/zip.js) and the Google Keep
// import (app/js/core/keep-import.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { zipEntries } from "../app/js/core/zip.js";
import { zipFiles, crc32 } from "../app/js/core/export.js";
import { keepNote, keepNotes, readKeepZip, toNoteDown, droppedText } from "../app/js/core/keep-import.js";
import { serializeNotesFile, parseNotesFile } from "../app/js/core/notes-file.js";

const sample = JSON.parse(readFileSync(new URL("../app/sample/keep.json", import.meta.url), "utf8")).files;
const sampleFiles = sample.map(f => ({ name: f.name, text: JSON.stringify(f.json) }));
const byFile = name => keepNote(sample.find(f => f.name.endsWith(name)).json, name);

// A ZIP with deflated entries, as Takeout writes it.
function deflatedZip(files) {
  const enc = new TextEncoder();
  const local = [], central = [];
  let offset = 0;
  const le = (v, n) => Array.from({ length: n }, (_, i) => (v >>> (8 * i)) & 0xff);
  for (const f of files) {
    const name = enc.encode(f.name), data = enc.encode(f.text), packed = deflateRawSync(data);
    const common = [...le(20, 2), ...le(0x0800, 2), ...le(8, 2), ...le(0, 4), ...le(crc32(data), 4), ...le(packed.length, 4), ...le(data.length, 4), ...le(name.length, 2), ...le(0, 2)];
    const head = Uint8Array.from([...le(0x04034b50, 4), ...common]);
    local.push(head, name, packed);
    central.push(Uint8Array.from([...le(0x02014b50, 4), ...le(20, 2), ...common, ...le(0, 6), ...le(0, 4), ...le(offset, 4)]), name);
    offset += head.length + name.length + packed.length;
  }
  const size = central.reduce((s, b) => s + b.length, 0);
  const end = Uint8Array.from([...le(0x06054b50, 4), ...le(0, 4), ...le(files.length, 2), ...le(files.length, 2), ...le(size, 4), ...le(offset, 4), ...le(0, 2)]);
  return Buffer.concat([...local, ...central, end].map(b => Buffer.from(b)));
}

test("zip: reads stored and deflated entries, names in UTF-8", async () => {
  const files = [{ name: "Takeout/Keep/Bücher.json", text: "{\"title\":\"x\"}" }, { name: "a.txt", text: "hello ".repeat(50) }];
  for (const bytes of [zipFiles(files), deflatedZip(files)]) {
    const entries = zipEntries(new Uint8Array(bytes));
    assert.deepEqual(entries.map(e => e.name), files.map(f => f.name));
    assert.equal(new TextDecoder().decode(await entries[1].read()), files[1].text);
  }
  assert.throws(() => zipEntries(new TextEncoder().encode("no zip here, just text")), /not a zip/);
});

test("keep: title, text, checklist and labels become Markdown", () => {
  const n = byFile("Weekly groceries.json");
  assert.equal(n.body, "## Weekly groceries\n- [x] Oat milk\n- [ ] Coffee beans (the Ethiopian ones)\n- [ ] Tomatoes, basil, mozzarella\n- [ ] Dishwasher tablets\n\n#Shopping");
  assert.equal(n.status, "open");
  assert.equal(n.created, "2026-10-13T08:05Z");
  assert.equal(n.modified, "2026-10-13T08:40Z");
  assert.ok(n.shared);
  assert.equal(byFile("Garden plan for spring.json").body.split("\n").at(-1), "#Home #Garden");
});

test("keep: archived → closed, pinned → permanent, attachments counted", () => {
  const photos = byFile("Holiday photos.json");
  assert.equal(photos.status, "closed");
  assert.equal(droppedText(photos.dropped), "2 images");
  assert.equal(byFile("Book ideas.json").status, "permanent");
  const imageOnly = byFile("2026-09-21T10_00_00.000+02_00.json");
  assert.equal(imageOnly.hasText, false);
  assert.equal(droppedText(byFile("2026-10-07T07_10_00.000+02_00.json").dropped), "1 recording");
});

test("keep: trash left out and counted, newest first, other JSON ignored", () => {
  const { notes, trashed } = keepNotes([...sampleFiles, { name: "Takeout/archive_browser.json", text: "[]" }, { name: "broken.json", text: "{" }]);
  assert.equal(trashed, 1);
  assert.equal(notes.length, sample.length - 1);
  assert.deepEqual(notes.map(n => n.modified), [...notes.map(n => n.modified)].sort().reverse());
});

test("keep: a Takeout ZIP reads only the Keep folder", async () => {
  const bytes = deflatedZip([...sampleFiles, { name: "Takeout/Calendar/x.json", text: "{\"title\":\"not keep\"}" }]);
  const { notes } = await readKeepZip(new Uint8Array(bytes));
  assert.equal(notes.length, sample.length - 1);
});

test("keep: imported notes keep dates and status through the file format", () => {
  const notes = [byFile("Holiday photos.json"), byFile("Book ideas.json")].map(toNoteDown);
  const back = parseNotesFile(serializeNotesFile({ preamble: "", notes })).notes;
  assert.equal(back[0].status, "closed");
  assert.equal(back[0].closed, "2026-10-04T09:00Z");
  assert.equal(back[1].status, "permanent");
  assert.equal(back[1].created, "2026-10-11T09:15Z");
  assert.notEqual(back[0].id, back[1].id);
});

// Export (app/js/core/export.js): Markdown with contents and markers, file names, ZIP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNotesFile } from "../app/js/core/notes-file.js";
import { partText } from "../app/js/core/selection.js";
import { exportMarkdown, anchors, exportFileName, crc32, zipFiles } from "../app/js/core/export.js";

const { notes } = parseNotesFile(readFileSync(new URL("../app/sample/notes.md", import.meta.url), "utf8"));
const byId = id => notes.find(n => n.id === id);
const whole = (...ids) => ids.map(id => ({ note: byId(id), text: byId(id).body }));

test("export: plain Markdown without markers, notes joined by a blank line", () => {
  const md = exportMarkdown([{ items: whole("s01", "s02") }]);
  assert.equal(md, byId("s01").body + "\n\n" + byId("s02").body + "\n");
  assert.ok(!md.includes("<!--"));
});

test("export: metadata writes each note's marker once, before its first part", () => {
  const s03 = byId("s03");
  const parts = [{ noteId: "s03", from: 1, to: 2 }, { noteId: "s03", from: 5, to: 6 }];
  const md = exportMarkdown([{ items: parts.map(p => ({ note: s03, text: partText(s03.body, p) })) }], { metadata: true });
  assert.equal(md.match(/<!-- note id=s03 /g).length, 1);
  assert.ok(md.startsWith("<!-- note id=s03 status=open created=2026-10-02T10:00Z modified=2026-10-12T21:10Z due=2026-10-17 color=blue decor=waves -->\n### Before we go"));
  // Round trip: an export with markers reads back as the same notes.
  const back = parseNotesFile(exportMarkdown([{ items: whole("s01", "s04") }], { metadata: true })).notes;
  assert.deepEqual(back.map(n => [n.id, n.body]), [["s01", byId("s01").body], ["s04", byId("s04").body]]);
});

test("export: table of contents links headings, lists untitled notes in italics, respects the depth", () => {
  const md = exportMarkdown([{ items: whole("s01", "s02", "s03") }], { toc: true, depth: 2 });
  const toc = md.split("\n\n---\n\n")[0];
  assert.ok(toc.startsWith("**Contents**\n\n- [Weekly groceries](#weekly-groceries)\n"));
  assert.ok(toc.includes("  - *Remind Lea that the bike needs new brake pads before the trip on Saturday.*"));
  assert.ok(toc.includes("- [Trip to Lisbon](#trip-to-lisbon)\n  - [Before we go](#before-we-go)"));
  assert.ok(!toc.includes("Sintra"));   // level 3 with depth 2
  assert.ok(exportMarkdown([{ items: whole("s03") }], { toc: true, depth: 3 }).includes("    - [Sintra](#sintra)"));
});

test("export: the archive group follows under a rule and its label", () => {
  const closed = notes.find(n => n.status === "closed");
  const md = exportMarkdown([{ items: whole("s01") }, { label: "Archive", items: [{ note: closed, text: closed.body }] }]);
  assert.ok(md.includes(byId("s01").body + "\n\n---\n\n**Archive**\n\n" + closed.body));
  assert.ok(!exportMarkdown([{ items: whole("s01") }, { label: "Archive", items: [] }]).includes("Archive"));
});

test("export: anchors follow GitHub's rules, repeats are numbered", () => {
  const slug = anchors();
  assert.equal(slug("Trip to Lisbon"), "trip-to-lisbon");
  assert.equal(slug("Tax return 2025"), "tax-return-2025");
  assert.equal(slug("Packing?"), "packing");
  assert.equal(slug("Packing"), "packing-1");
});

test("export: file names are safe and unique", () => {
  assert.equal(exportFileName("Private"), "Private.md");
  assert.equal(exportFileName("Lea, Tom"), "Lea, Tom.md");
  assert.equal(exportFileName("A/B"), "A_B.md");
  assert.equal(exportFileName("Lea", ["Lea.md"]), "Lea (2).md");
});

test("export: ZIP holds the files unchanged (checked with Python's zipfile when available)", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  const files = [{ name: "Private.md", text: byId("s01").body }, { name: "Lea, Tom.md", text: "Ünïcode ✓\n" }];
  const zip = zipFiles(files, new Date(2026, 9, 14, 9, 30));
  assert.deepEqual([...zip.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  let python;
  try { execFileSync("python3", ["--version"]); python = true; } catch { python = false; }
  if (!python) return;
  const dir = mkdtempSync(join(tmpdir(), "nd-zip-"));
  writeFileSync(join(dir, "a.zip"), zip);
  const out = execFileSync("python3", ["-I", "-c",
    "import sys,zipfile,json; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps([[i.filename, z.read(i).decode()] for i in z.infolist()]))",
    join(dir, "a.zip")], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(out), files.map(f => [f.name, f.text]));
});

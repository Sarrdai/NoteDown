// Unit tests for a note's color, motif and texture (app/js/core/look.js) in the file format and the merge. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { commonLook, validColor, validDecor, validTexture, keepColor } from "../app/js/core/look.js";
import { parseNotesFile, serializeNotesFile } from "../app/js/core/notes-file.js";
import { mergeNotesFiles } from "../app/js/core/merge.js";

const text = readFileSync(new URL("../app/sample/notes.md", import.meta.url), "utf8");
const { notes, sources, order } = parseNotesFile(text);
const byId = id => notes.find(n => n.id === id);

test("look: color and motif are marker attributes and survive a round trip", () => {
  assert.equal(byId("s03").color, "blue");
  assert.equal(byId("s03").decor, "travel");
  assert.equal(byId("s01").color, undefined);
  assert.equal(byId("s01").decor, "shopping");
  assert.equal(byId("s05").texture, "grain");
  assert.equal(byId("s03").texture, undefined);
  assert.equal(serializeNotesFile({ notes, sources, order }), text);
});

test("look: unknown values read as none", () => {
  const [n] = parseNotesFile("<!-- note id=a status=open created=2026-10-13T08:05Z modified=2026-10-13T08:05Z color=chartreuse decor=unicorns texture=velvet -->\nx").notes;
  assert.equal(n.color, undefined);
  assert.equal(n.decor, undefined);
  assert.equal(n.texture, undefined);
  assert.equal(validTexture("grain"), "grain");
  assert.equal(validColor("red"), "red");
  assert.equal(validDecor("plaid"), null);
  assert.equal(keepColor("CERULEAN"), "blue");
});

test("look: commonLook says what several notes share", () => {
  assert.deepEqual(commonLook([byId("s03")]), { color: "blue", decor: "travel", texture: null, mixed: { color: false, decor: false, texture: false } });
  assert.deepEqual(commonLook([byId("s03"), byId("s05")]), { color: null, decor: null, texture: null, mixed: { color: true, decor: true, texture: true } });
  assert.deepEqual(commonLook([byId("s02"), byId("s07")]), { color: null, decor: null, texture: null, mixed: { color: false, decor: false, texture: false } });
});

test("look: color and motif merge on their own, beside a text edit", () => {
  const base = parseNotesFile(text);
  const edit = (id, patch) => ({ ...base, notes: base.notes.map(n => (n.id === id ? { ...n, ...patch } : n)) });
  const local = edit("s01", { color: "green", modified: "2026-10-13T09:00Z" });
  const remote = edit("s01", { body: "changed", decor: "dots", texture: "grain", modified: "2026-10-13T09:30Z" });
  const merged = mergeNotesFiles(base, local, remote).file.notes.find(n => n.id === "s01");
  assert.equal(merged.color, "green");
  assert.equal(merged.decor, "dots");
  assert.equal(merged.texture, "grain");
  assert.equal(merged.body, "changed");
  const cleared = mergeNotesFiles(base, edit("s03", { color: undefined }), base).file.notes.find(n => n.id === "s03");
  assert.equal(cleared.color, undefined);
  assert.equal(cleared.decor, "travel");
});

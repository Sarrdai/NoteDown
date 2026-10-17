// Unit tests for labels (app/js/core/labels.js) and their rendering. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { labelsOf, hasLabel, labelCounts, toLabel } from "../app/js/core/labels.js";
import { renderMarkdown, headings } from "../app/js/core/markdown.js";
import { parseNotesFile } from "../app/js/core/notes-file.js";

const { notes } = parseNotesFile(readFileSync(new URL("../app/sample/notes.md", import.meta.url), "utf8"));

test("labels: hashtags after a space or line start, once each, first spelling kept", () => {
  assert.deepEqual(labelsOf("#Travel to Lisbon, then #travel again\n- [ ] (#home) and #home/garden."), ["Travel", "home", "home/garden"]);
  assert.deepEqual(labelsOf("#2024-taxes but not #5"), ["2024-taxes"]);
});

test("labels: headings, words with #, code and link targets carry none", () => {
  assert.deepEqual(labelsOf("## Heading\nissue#5 `#code`\n```\n#fenced\n```\n[x](https://a.example/#anchor) https://b.example/#frag"), []);
});

test("labels: hasLabel ignores case; counts over the sample, A–Z", () => {
  assert.ok(hasLabel("Buy milk #Shopping", "shopping"));
  assert.ok(!hasLabel("Buy milk #shoppingList", "shopping"));
  const counts = labelCounts(notes);
  assert.deepEqual(counts.map(c => c.name), [...counts.map(c => c.name)].sort((a, b) => a.localeCompare(b)));
  assert.equal(counts.find(c => c.name === "paperwork").count, 3);
});

test("labels: names from other apps become labels", () => {
  assert.equal(toLabel(" Trip ideas! "), "Trip-ideas");
  assert.equal(toLabel("2024"), null);
  assert.equal(toLabel("Ärzte & Termine"), "Ärzte-Termine");
});

test("labels: rendered as chips, not in code, headings keep their text", () => {
  const html = renderMarkdown("Pack #travel and `#code`");
  assert.match(html, /<button type="button" class="label-chip" data-label="travel">#travel<\/button>/);
  assert.match(html, /<code>#code<\/code>/);
  assert.deepEqual(headings("## Lisbon #travel"), [{ depth: 2, text: "Lisbon #travel" }]);
});

test("labels: emoji count as labels, alone or with letters", () => {
  assert.deepEqual(labelsOf("Party #🎂 and #😉, #👍🏽ok #🏳️‍🌈 #🇩🇪 #trip✈️"), ["🎂", "😉", "👍🏽ok", "🏳️‍🌈", "🇩🇪", "trip✈️"]);
  assert.deepEqual(labelsOf("Keycaps #️⃣ and #1️⃣ are no labels"), []);
  assert.equal(toLabel("Party 🎉!"), "Party-🎉");
  assert.match(renderMarkdown("Mia #🎂"), /<button type="button" class="label-chip" data-label="🎂">#🎂<\/button>/);
});

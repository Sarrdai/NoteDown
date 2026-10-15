// Unit tests for the editor's Markdown commands (app/js/core/md-commands.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cycleHeading, toggleBullet, toggleTaskItem, toggleTaskChecked, indentLine, outdentLine, continueList, toggleWrap, insertLink, joinDictation, listPrefix } from "../app/js/core/md-commands.js";

test("cycleHeading: none → # → ## → ### → #### → none, list markers dropped", () => {
  assert.equal(cycleHeading("Title"), "# Title");
  assert.equal(cycleHeading("# Title"), "## Title");
  assert.equal(cycleHeading("## Title"), "### Title");
  assert.equal(cycleHeading("### Title"), "#### Title");
  assert.equal(cycleHeading("#### Title"), "Title");
  assert.equal(cycleHeading("- [ ] Item"), "# Item");
});

test("toggleBullet and toggleTaskItem keep the indent", () => {
  assert.equal(toggleBullet("Milk"), "- Milk");
  assert.equal(toggleBullet("  - Milk"), "  Milk");
  assert.equal(toggleBullet("  - [ ] Milk"), "  - Milk");
  assert.equal(toggleBullet("1. Milk"), "- Milk");
  assert.equal(toggleTaskItem("Milk"), "- [ ] Milk");
  assert.equal(toggleTaskItem("  - Milk"), "  - [ ] Milk");
  assert.equal(toggleTaskItem("- [x] Milk"), "Milk");
  assert.equal(toggleTaskItem("## Milk"), "- [ ] Milk");
});

test("toggleTaskChecked ticks and unticks", () => {
  assert.equal(toggleTaskChecked("- [ ] Milk"), "- [x] Milk");
  assert.equal(toggleTaskChecked("  * [X] Milk"), "  * [ ] Milk");
  assert.equal(toggleTaskChecked("Milk"), "- [ ] Milk");
});

test("indent and outdent", () => {
  assert.equal(indentLine("- a"), "  - a");
  assert.equal(outdentLine("  - a"), "- a");
  assert.equal(outdentLine(" - a"), "- a");
  assert.equal(outdentLine("- a"), "- a");
});

test("continueList continues bullets, tasks and numbers, ends on an empty item", () => {
  assert.deepEqual(continueList("- a"), { prefix: "- " });
  assert.deepEqual(continueList("  - [x] a"), { prefix: "  - [ ] " });
  assert.deepEqual(continueList("3) a"), { prefix: "4) " });
  assert.deepEqual(continueList("- [ ] "), { clear: true });
  assert.equal(continueList("plain"), null);
  assert.equal(listPrefix("-not a list"), null);
});

test("toggleWrap wraps and unwraps", () => {
  assert.deepEqual(toggleWrap("a word b", 2, 6, "**"), { text: "a **word** b", from: 4, to: 8 });
  assert.deepEqual(toggleWrap("a **word** b", 4, 8, "**"), { text: "a word b", from: 2, to: 6 });
  assert.deepEqual(toggleWrap("a **word** b", 2, 10, "**"), { text: "a word b", from: 2, to: 6 });
  assert.deepEqual(toggleWrap("ab", 1, 1, "*"), { text: "a**b", from: 2, to: 2 });
});

test("insertLink selects the url placeholder", () => {
  const r = insertLink("see docs now", 4, 8);
  assert.equal(r.text, "see [docs](url) now");
  assert.equal(r.text.slice(r.from, r.to), "url");
});

test("joinDictation adds one space where needed", () => {
  assert.equal(joinDictation("Hello", " world "), " world");
  assert.equal(joinDictation("Hello ", "world"), "world");
  assert.equal(joinDictation("", "world"), "world");
  assert.equal(joinDictation("x", "  "), "");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { counters, stepCounter, addStep, appendCounter, counterStart, COUNTER_AT } from "../app/js/core/counter.js";
import { renderMarkdown, noteTitle } from "../app/js/core/markdown.js";
import { parseNotesFile } from "../app/js/core/notes-file.js";

const { notes } = parseNotesFile(readFileSync(new URL("../app/sample/notes.md", import.meta.url), "utf8"));
const tracker = notes.find(n => counters(n.body).length >= 2);

test("the sample has a note with counters", () => {
  assert.ok(tracker);
});

test("counters finds number and steps, outside code", () => {
  const body = "A: 12 [-4 -1 +1 +8]\n`3 [+1]`\n```\n5 [+1]\n```\n  - B 0,5 [+0,5]";
  const cs = counters(body);
  assert.deepEqual(cs.map(c => [c.value, c.steps]), [["12", ["-4", "-1", "+1", "+8"]], ["0,5", ["+0,5"]]]);
  assert.equal(body.slice(cs[0].from, cs[0].to), "12");
});

test("a number glued to a word or another number is no counter", () => {
  assert.equal(counters("a12 [+1]").length, 0);
  assert.equal(counters("v1.12 [+1]").length, 0);
  assert.equal(counters("1-12 [+1]").length, 0);
  assert.equal(counters("12 [1]").length, 0);
  assert.equal(counters("12 [+1 x]").length, 0);
  assert.equal(counters("12[+1]").length, 1);
});

test("addStep keeps the decimals and the comma as written", () => {
  assert.equal(addStep("12", "+8"), "20");
  assert.equal(addStep("2", "-4"), "-2");
  assert.equal(addStep("0,5", "+1"), "1,5");
  assert.equal(addStep("1", "+0.25"), "1.25");
  assert.equal(addStep("0.1", "+0.2"), "0.3");
  assert.equal(addStep("0,5", "-0,5"), "0,0");
  assert.equal(addStep("1", "-1"), "0");
});

test("stepCounter changes only the n-th counter's number", () => {
  const body = "A 1 [+1]\nB 10 [-4 +8]";
  assert.equal(stepCounter(body, 1, "-4"), "A 1 [+1]\nB 6 [-4 +8]");
  assert.equal(stepCounter(body, 0, "+1"), "A 2 [+1]\nB 10 [-4 +8]");
  assert.equal(stepCounter(body, 5, "+1"), body);
});

test("appendCounter adds a counter at the line's end", () => {
  assert.equal(appendCounter(""), "0 [-1 +1]");
  assert.equal(appendCounter("- Reading  "), "- Reading 0 [-1 +1]");
  assert.equal(appendCounter("- Reading 3 [+1]"), "- Reading 3 [+1]");
});

test("the renderer shows the counters in the order counters() finds them", () => {
  const html = renderMarkdown(tracker.body);
  const values = [...html.matchAll(/class="counter"[^>]*>([^<]*)</g)].map(m => m[1]);
  assert.deepEqual(values, counters(tracker.body).map(c => c.value));
  assert.match(renderMarkdown("x `3 [+1]`"), /<code>3 \[\+1\]<\/code>/);
});

test("titles show a counter's number without its steps", () => {
  assert.equal(noteTitle("Reading 3 [-1 +1]").text, "Reading 3");
});

test("counterStart and COUNTER_AT agree", () => {
  const src = "Hours: 7,5 [+1]";
  const at = counterStart(src);
  assert.equal(at, 7);
  assert.ok(COUNTER_AT.exec(src.slice(at)));
});

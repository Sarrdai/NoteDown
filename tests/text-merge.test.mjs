// Unit tests for the line-by-line merge of a note's text (app/js/core/text-merge.js, backlog #47). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNotesFile } from "../app/js/core/notes-file.js";
import { toggleTask } from "../app/js/core/markdown.js";
import { changeCounter } from "../app/js/core/counter.js";
import { mergeText, mergeLine } from "../app/js/core/text-merge.js";

const sample = parseNotesFile(readFileSync(new URL("../app/sample/notes.md", import.meta.url), "utf8"));
const body = id => sample.notes.find(n => n.id === id).body;
const shopping = body("s01"), hours = body("s20");
const lines = text => text.split("\n");
const line = (text, start) => lines(text).find(l => l.startsWith(start));
const swap = (text, from, to) => text.replace(from, to);

test("mergeText: one side changed, or both the same way, takes that text", () => {
  const ticked = toggleTask(shopping, 1);
  assert.equal(mergeText(shopping, ticked, shopping, true), ticked);
  assert.equal(mergeText(shopping, shopping, ticked, true), ticked);
  assert.equal(mergeText(shopping, ticked, ticked, false), ticked);
});

test("mergeText: tasks ticked on different lines combine", () => {
  const out = mergeText(shopping, toggleTask(shopping, 1), toggleTask(shopping, 3), true);
  assert.equal(out, toggleTask(toggleTask(shopping, 1), 3));
});

test("mergeText: a line edited on one side and another deleted on the other combine", () => {
  const coffee = line(shopping, "- [ ] Coffee"), tablets = line(shopping, "- [ ] Dishwasher");
  const edited = swap(shopping, coffee, coffee + " x2");
  const deleted = swap(shopping, tablets + "\n", "");
  assert.equal(mergeText(shopping, edited, deleted, true), swap(edited, tablets + "\n", ""));
});

test("mergeText: lines added at the same place on both sides are all kept, the remote ones first", () => {
  const lemonade = line(body("s09"), "- [ ] Lemonade"), cake = "- [ ] Order the cake";
  const tablets = line(shopping, "- [ ] Dishwasher");
  const local = swap(shopping, tablets, tablets + "\n" + lemonade);
  const remote = swap(shopping, tablets, tablets + "\n" + cake);
  assert.equal(mergeText(shopping, local, remote, true), swap(shopping, tablets, [tablets, cake, lemonade].join("\n")));
  // The same line added on both sides comes in once.
  assert.equal(mergeText(shopping, local, local, false), local);
});

test("mergeText: an addition next to an edited line keeps both in order", () => {
  const coffee = line(shopping, "- [ ] Coffee"), lemonade = line(body("s09"), "- [ ] Lemonade");
  const edited = swap(shopping, coffee, coffee + " x2");
  const added = swap(shopping, coffee, lemonade + "\n" + coffee);
  assert.equal(mergeText(shopping, edited, added, true), swap(shopping, coffee, lemonade + "\n" + coffee + " x2"));
});

test("mergeText: the same line changed differently on both sides doesn't merge", () => {
  const coffee = line(shopping, "- [ ] Coffee");
  const a = swap(shopping, coffee, coffee + " x2"), b = swap(shopping, coffee, coffee + " x3");
  assert.equal(mergeText(shopping, a, b, true), null);
  // An edit on one side and a delete of the same line on the other neither.
  assert.equal(mergeText(shopping, a, swap(shopping, coffee + "\n", ""), true), null);
});

test("mergeLine: a task's box and its text merge apart; both boxes changed takes the newer side's", () => {
  const coffee = line(shopping, "- [ ] Coffee");
  const ticked = coffee.replace("[ ]", "[x]"), cancelled = coffee.replace("[ ]", "[-]");
  assert.equal(mergeLine(coffee, ticked, coffee + " x2", true), ticked + " x2");
  assert.equal(mergeLine(coffee, ticked, cancelled, true), ticked);
  assert.equal(mergeLine(coffee, ticked, cancelled, false), cancelled);
});

test("mergeText: counter steps on both sides add up, in every kind", () => {
  for (const [index, a, b] of [[0, "+1", "-4"], [1, "+0,5", "+1"], [2, "+0:15", "+1:00"], [3, "+1", "-1"]]) {
    const both = changeCounter(changeCounter(hours, index, { step: a }), index, { step: b });
    assert.equal(mergeText(hours, changeCounter(hours, index, { step: a }), changeCounter(hours, index, { step: b }), true), both);
  }
  // The very same change on both sides can't be told from one change that both have: it counts once.
  const once = changeCounter(hours, 3, { step: "+1" });
  assert.equal(mergeText(hours, once, once, true), once);
  const relaunch = line(hours, "- P-2041");
  const plusOne = changeCounter(hours, 0, { step: "+1" }), plusEight = changeCounter(hours, 0, { step: "+8" });
  assert.equal(line(mergeText(hours, plusOne, plusEight, true), "- P-2041"), relaunch.replace("23,5", "32,5"));
  const hotline = changeCounter(hours, 2, { step: "+0:15" }), hotlineMore = changeCounter(hours, 2, { step: "-0:15" });
  assert.equal(mergeText(hours, hotline, hotlineMore, false), hours);
});

test("mergeText: a counter stepped on one side and its label edited on the other combine", () => {
  const relaunch = line(hours, "- P-2041");
  const stepped = changeCounter(hours, 0, { step: "+1" });
  const renamed = swap(hours, "Website relaunch", "Website relaunch phase 2");
  assert.equal(line(mergeText(hours, stepped, renamed, true), "- P-2041"), relaunch.replace("Website relaunch", "Website relaunch phase 2").replace("23,5", "24,5"));
});

test("mergeText: a stopwatch started on both sides runs once, from the earlier start", () => {
  const t1 = Date.parse("2026-10-16T08:05:12Z"), t2 = Date.parse("2026-10-16T08:01:00Z");
  const a = changeCounter(hours, 2, { watch: "start", now: t1 }), b = changeCounter(hours, 2, { watch: "start", now: t2 });
  assert.equal(mergeText(hours, a, b, true), b);
});

test("mergeText: a running stopwatch stopped on one side and stepped on the other keeps both, stopped", () => {
  const start = Date.parse("2026-10-16T08:00:00Z"), stop = Date.parse("2026-10-16T08:40:00Z");
  const running = changeCounter(hours, 2, { watch: "start", now: start });
  const stopped = changeCounter(running, 2, { watch: "stop", now: stop });   // +0:40
  const stepped = changeCounter(running, 2, { step: "+0:15" });
  assert.equal(mergeText(running, stopped, stepped, true), changeCounter(stopped, 2, { step: "+0:15" }));
});

test("mergeText: a stopwatch stopped on both sides takes the newer side, so the run counts once", () => {
  const start = Date.parse("2026-10-16T08:00:00Z");
  const running = changeCounter(hours, 2, { watch: "start", now: start });
  const early = changeCounter(running, 2, { watch: "stop", now: start + 30 * 60e3 });
  const late = changeCounter(running, 2, { watch: "stop", now: start + 45 * 60e3 });
  assert.equal(mergeText(running, early, late, false), late);
  assert.equal(mergeText(running, early, late, true), early);
});

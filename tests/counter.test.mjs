import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runningWatches, counters, stepCounter, changeCounter, addStep, sumSteps, pendingText, appendCounter, counterStart, counterAt, parseAmount, watchStep, isZero } from "../app/js/core/counter.js";
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
  assert.equal(body.slice(cs[0].from, cs[0].to), "12 [-4 -1 +1 +8]");
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

test("sumSteps adds the pending taps, pendingText shows them after the value", () => {
  assert.equal(sumSteps(sumSteps("+0", "+4"), "+4"), "+8");
  assert.equal(sumSteps("+0", "-1"), "-1");
  assert.equal(sumSteps("+1", "-1"), "+0");
  assert.equal(sumSteps("+0", "+0,5"), "+0,5");
  assert.equal(pendingText("36", "+8"), "36 + 8");
  assert.equal(pendingText("36", "-2"), "36 − 2");
  assert.equal(pendingText("23,5", "+0,5"), "23,5 + 0,5");
  assert.equal(pendingText("36", "+0"), "36");
  assert.equal(stepCounter("A 36 [+4]", 0, "+8"), "A 44 [+4]");
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
  assert.equal(appendCounter("P-2063 Support hotline:", true), "P-2063 Support hotline: 0:00 [-0:15 +0:15 ⏱15]");
});

test("the renderer shows the counters in the order counters() finds them", () => {
  const html = renderMarkdown(tracker.body);
  const values = [...html.matchAll(/class="counter-value">([^<]*)</g)].map(m => m[1]);
  assert.deepEqual(values, counters(tracker.body).map(c => c.value + (c.unit ? " " + c.unit : "")));
  assert.match(renderMarkdown("x `3 [+1]`"), /<code>3 \[\+1\]<\/code>/);
});

test("titles show a counter's number without its steps", () => {
  assert.equal(noteTitle("Reading 3 [-1 +1]").text, "Reading 3");
});

test("counterStart and counterAt agree", () => {
  const src = "Hours: 7,5 [+1]";
  const at = counterStart(src);
  assert.equal(at, 7);
  assert.ok(counterAt(src.slice(at)));
  // An invalid match is skipped, the next counter is found.
  assert.equal(counterStart("12 [+1:00] and 3 [+1]"), 15);
});

test("time and hours counters: h:mm steps with an h:mm value, a stopwatch only with time or hours", () => {
  const [time, hours] = counters("P-2063 Support hotline: 3:45 [-0:15 +0:15 ⏱]\nP-2041 Website relaunch: 23,5 h [-4 -1 +1 +8 ⏱15]");
  assert.equal(time.kind, "time");
  assert.deepEqual(time.steps, ["-0:15", "+0:15"]);
  assert.deepEqual(time.watch, { round: 0, since: null });
  assert.equal(hours.kind, "hours");
  assert.equal(hours.unit, "h");
  assert.deepEqual(hours.watch, { round: 15, since: null });
  assert.equal(counters("3:45 [+1]").length, 0);       // a time needs h:mm steps
  assert.equal(counters("12 [+0:15]").length, 0);      // and a number number steps
  assert.equal(counters("12 [+1 ⏱]").length, 0);       // a plain number has no stopwatch (which unit?)
  assert.equal(counters("12 h [⏱]").length, 1);        // a stopwatch alone is enough
  assert.equal(counters("3:45 h [+0:15]").length, 0);
  assert.equal(counters("12 [+1 2026-10-16T08:05Z]").length, 0);
  assert.equal(counters("0:00 [⏱15 2026-10-16T08:05Z]")[0].watch.since, "2026-10-16T08:05Z");
});

test("h:mm arithmetic", () => {
  assert.equal(addStep("3:45", "+0:15"), "4:00");
  assert.equal(addStep("0:10", "-0:15"), "-0:05");
  assert.equal(sumSteps(sumSteps("+0", "+0:15"), "+1:00"), "+1:15");
  assert.equal(sumSteps("+0:15", "-0:15"), "+0:00");
  assert.ok(isZero("+0:00"));
  assert.equal(pendingText("3:45", "+1:15"), "3:45 + 1:15");
});

test("parseAmount reads a typed amount in the counter's kind", () => {
  assert.equal(parseAmount("40", "time"), "+0:40");
  assert.equal(parseAmount("90", "time"), "+1:30");
  assert.equal(parseAmount("-1:20", "time"), "-1:20");
  assert.equal(parseAmount("1,5", "time"), null);
  assert.equal(parseAmount("1,5", "hours"), "+1,5");
  assert.equal(parseAmount("−2", "number"), "-2");
  assert.equal(parseAmount("0", "number"), null);
  assert.equal(parseAmount("abc", "number"), null);
});

test("the stopwatch: start writes the time, stop adds the run rounded up", () => {
  const t0 = Date.parse("2026-10-16T08:05:00Z");
  const body = "P-2041 Website relaunch: 23,5 h [-4 -1 +1 +8 ⏱15]\nP-2063 Support hotline: 3:45 [-0:15 +0:15 ⏱]";
  const started = changeCounter(body, 0, { watch: "start", now: t0 });
  assert.ok(started.startsWith("P-2041 Website relaunch: 23,5 h [-4 -1 +1 +8 ⏱15 2026-10-16T08:05:00Z]"));
  // 20 minutes round up to 30 = 0,5 h.
  const stopped = changeCounter(started, 0, { watch: "stop", now: t0 + 20 * 60000 });
  assert.ok(stopped.startsWith("P-2041 Website relaunch: 24,0 h [-4 -1 +1 +8 ⏱15]\n"), stopped);
  // To the minute, h:mm; a pending step goes in with it.
  const t = changeCounter(changeCounter(body, 1, { watch: "start", now: t0 }), 1, { step: "+0:15", watch: "stop", now: t0 + 61 * 60000 + 5000 });
  assert.ok(t.endsWith("P-2063 Support hotline: 5:02 [-0:15 +0:15 ⏱]"), t);
  // Discarding ends the run without adding it.
  assert.equal(changeCounter(started, 0, { watch: "discard", now: t0 + 20 * 60000 }), body);
  // Stopping a stopwatch that doesn't run changes nothing.
  assert.equal(changeCounter(body, 1, { watch: "stop", now: t0 }), body);
  assert.equal(watchStep({ kind: "hours", value: "1.5", watch: { round: 0, since: "2026-10-16T08:05Z" } }, t0 + 10 * 60000), "+0.17");
});

test("runningWatches lists the running stopwatches with the text before them", () => {
  const body = "## Hours in October\n- P-2041 Website relaunch: 23,5 h [-4 -1 +1 +8 ⏱15 2026-10-16T08:05:12Z]\n- P-2057 Annual report: 6 [-1 -0,5 +0,5 +1]\n- [ ] **P-2063 Support hotline**: 3:45 [-0:15 +0:15 ⏱ 2026-10-16T09:00:00Z]\n3:45 [⏱ 2026-10-16T09:00:00Z]";
  assert.deepEqual(runningWatches(body), [
    { index: 0, since: "2026-10-16T08:05:12Z", label: "P-2041 Website relaunch" },
    { index: 2, since: "2026-10-16T09:00:00Z", label: "P-2063 Support hotline" },
    { index: 3, since: "2026-10-16T09:00:00Z", label: "" },
  ]);
});

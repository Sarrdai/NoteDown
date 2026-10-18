import { test } from "node:test";
import assert from "node:assert/strict";
import { tidyChoice, circleLevel, pileState, TIDY_PRESETS } from "../app/js/core/tidy.js";

const NOW = Date.parse("2026-10-18T12:00Z");
const daysAgo = d => new Date(NOW - d * 86400000).toISOString();

test("tidyChoice: private on by default, shared circles off, an own choice wins", () => {
  assert.equal(tidyChoice(undefined, ""), "normal");
  assert.equal(tidyChoice({}, "lea"), "off");
  assert.equal(tidyChoice({ "": "off", lea: "often" }, ""), "off");
  assert.equal(tidyChoice({ lea: "often" }, "lea"), "often");
  assert.equal(tidyChoice({ lea: "bogus" }, "lea"), "off");
});

test("circleLevel: tidy at the threshold, growing from half of it, by count or age", () => {
  const p = TIDY_PRESETS.normal;   // 10 notes or 7 days
  assert.equal(circleLevel(2, 1, p), "calm");
  assert.equal(circleLevel(5, 1, p), "growing");
  assert.equal(circleLevel(2, 3.5, p), "growing");
  assert.equal(circleLevel(10, 0, p), "tidy");
  assert.equal(circleLevel(1, 7, p), "tidy");
});

test("pileState: the highest circle level; circles with the reminder off don't count", () => {
  const choice = k => ({ "": "normal", lea: "often" })[k] || "off";
  const pile = [
    { circle: "", created: daysAgo(1) },
    { circle: "lea", created: daysAgo(4) },
    { circle: "tom", created: daysAgo(90) },
  ];
  assert.deepEqual(pileState(pile, choice, NOW), { level: "tidy", count: 3, oldest: daysAgo(4) });
  assert.deepEqual(pileState(pile.filter(n => n.circle !== "lea"), choice, NOW), { level: "calm", count: 2, oldest: daysAgo(1) });
  assert.deepEqual(pileState([pile[2]], choice, NOW), { level: null, count: 1, oldest: null });
  assert.deepEqual(pileState([], choice, NOW), { level: null, count: 0, oldest: null });
});

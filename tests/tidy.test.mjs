import { test } from "node:test";
import assert from "node:assert/strict";
import { tidyConfig, tidyCounted, filledBars, tidyLevel, pileState, TIDY_DEFAULTS } from "../app/js/core/tidy.js";

const NOW = Date.parse("2026-10-18T12:00Z");
const daysAgo = d => new Date(NOW - d * 86400000).toISOString();

test("tidyConfig: defaults, whole numbers, clamped to the limits", () => {
  assert.deepEqual(tidyConfig(undefined), TIDY_DEFAULTS);
  assert.deepEqual(tidyConfig({ bars: 4, notes: 2, days: 5 }), { bars: 4, notes: 2, days: 5 });
  assert.deepEqual(tidyConfig({ bars: 42, notes: 0, days: 2.6 }), { bars: 10, notes: 1, days: 3 });
  assert.deepEqual(tidyConfig({ bars: "x" }), TIDY_DEFAULTS);
});

test("tidyCounted: private counted by default, shared ignored, an own choice wins; old presets read", () => {
  assert.equal(tidyCounted(undefined, ""), true);
  assert.equal(tidyCounted({}, "lea"), false);
  assert.equal(tidyCounted({ circles: { "": false, lea: true } }, ""), false);
  assert.equal(tidyCounted({ circles: { lea: true } }, "lea"), true);
  assert.equal(tidyCounted({ "": "off", lea: "often" }, ""), false);
  assert.equal(tidyCounted({ lea: "often" }, "lea"), true);
});

test("filledBars: whole steps of notes and of days added, capped at the bars (the user's example)", () => {
  const cfg = { bars: 4, notes: 2, days: 5 };
  assert.equal(filledBars(3, 11, cfg), 3);    // 3 notes → 1, 11 days → 2
  assert.equal(filledBars(1, 4.9, cfg), 0);
  assert.equal(filledBars(9, 30, cfg), 4);    // more than fits shows full, no more
});

test("tidyLevel: yellow from 75 % but at the latest one bar before full, red when full", () => {
  assert.equal(tidyLevel(2, 4), "calm");
  assert.equal(tidyLevel(3, 4), "warn");
  assert.equal(tidyLevel(4, 4), "full");
  assert.equal(tidyLevel(7, 10), "calm");
  assert.equal(tidyLevel(8, 10), "warn");
  assert.equal(tidyLevel(2, 3), "warn");      // 67 %, but one before full
  assert.equal(tidyLevel(1, 2), "warn");
  assert.equal(tidyLevel(0, 1), "calm");
  assert.equal(tidyLevel(1, 1), "full");
});

test("pileState: counted circles' notes taken together, ignored ones left out", () => {
  const cfg = { bars: 4, notes: 2, days: 5 };
  const counted = k => k === "" || k === "lea";
  const pile = [
    { circle: "", created: daysAgo(1) },
    { circle: "lea", created: daysAgo(11) },
    { circle: "", created: daysAgo(2) },
    { circle: "tom", created: daysAgo(90) },
  ];
  assert.deepEqual(pileState(pile, counted, cfg, NOW), { count: 4, bars: 4, filled: 3, level: "warn" });
  assert.deepEqual(pileState(pile.filter(n => n.circle !== "lea"), counted, cfg, NOW), { count: 3, bars: 4, filled: 1, level: "calm" });
  assert.deepEqual(pileState([pile[3]], counted, cfg, NOW), { count: 1, bars: 4, filled: 0, level: null });
  assert.deepEqual(pileState([], counted, cfg, NOW), { count: 0, bars: 4, filled: 0, level: null });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { toggleCircle, toggleLabel, hasAnyLabel } from "../app/js/core/filters.js";

const NEWS = "@news";

test("toggleCircle adds and removes keys, null clears", () => {
  assert.deepEqual(toggleCircle([], "lea", NEWS), ["lea"]);
  assert.deepEqual(toggleCircle(["lea"], "", NEWS), ["lea", ""]);
  assert.deepEqual(toggleCircle(["lea", ""], "lea", NEWS), [""]);
  assert.deepEqual(toggleCircle(["lea", ""], null, NEWS), []);
});

test("toggleCircle keeps the exclusive key alone", () => {
  assert.deepEqual(toggleCircle(["lea", "tom"], NEWS, NEWS), [NEWS]);
  assert.deepEqual(toggleCircle([NEWS], NEWS, NEWS), []);
  assert.deepEqual(toggleCircle([NEWS], "lea", NEWS), ["lea"]);
});

test("toggleLabel compares case-insensitively", () => {
  assert.deepEqual(toggleLabel([], "Travel"), ["Travel"]);
  assert.deepEqual(toggleLabel(["Travel"], "travel"), []);
  assert.deepEqual(toggleLabel(["Travel"], "home"), ["Travel", "home"]);
  assert.deepEqual(toggleLabel(["Travel", "home"], null), []);
});

test("hasAnyLabel matches any picked label, everything without one", () => {
  assert.equal(hasAnyLabel("plain", []), true);
  assert.equal(hasAnyLabel("off #home soon", ["travel", "Home"]), true);
  assert.equal(hasAnyLabel("off #home soon", ["travel"]), false);
});

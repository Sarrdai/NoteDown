import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzzyMatch, suggestions } from "../app/js/core/suggest.js";

test("fuzzyMatch finds the letters in order, ignoring case and accents", () => {
  assert.deepEqual(fuzzyMatch("trvl", "travel").ranges, [[0, 2], [3, 4], [5, 6]]);
  assert.ok(fuzzyMatch("CAFE", "Café"));
  assert.equal(fuzzyMatch("lvt", "travel"), null);
  assert.equal(fuzzyMatch("zz", "travel"), null);
});

test("fuzzyMatch ranks a run at the start over a word start over inside a word over scattered", () => {
  const score = (q, t) => fuzzyMatch(q, t).score;
  assert.ok(score("gar", "Garden plan") > score("gar", "Spring garden"));
  assert.ok(score("gar", "Spring garden") > score("gar", "Cigar box"));
  assert.ok(score("gar", "Cigar box") > score("gar", "Go around"));
  assert.deepEqual(fuzzyMatch("plan", "Garden plan").ranges, [[7, 11]]);
});

test("fuzzyMatch prefers word starts but still finds a match when they lead nowhere", () => {
  assert.deepEqual(fuzzyMatch("gp", "Garden plan").ranges, [[0, 1], [7, 8]]);
  assert.ok(fuzzyMatch("ab", "xab ya bx"));
});

test("fuzzyMatch drops loose letters that are neither initials nor partly together", () => {
  assert.equal(fuzzyMatch("li", "Weekly groceries"), null);
  assert.equal(fuzzyMatch("lhn", "Call the dentist"), null);
  assert.ok(fuzzyMatch("trvl", "travel"));
  assert.ok(fuzzyMatch("cd", "Call the dentist"));
});

const data = {
  permanent: 3,
  labels: [{ name: "travel", count: 2 }, { name: "paperwork", count: 2 }],
  circles: [{ key: "", name: "Private", count: 5 }, { key: "lea", name: "Lea", count: 4 }],
  headings: ["Trip to Lisbon", "Packing", "Trip to Lisbon"],
};

test("without text every filter is offered, no headings", () => {
  assert.deepEqual(suggestions("", data).map(s => s.text), ["Permanent", "#travel", "#paperwork", "Private", "Lea"]);
  assert.deepEqual(suggestions("", { ...data, permanent: 0 }).map(s => s.kind), ["label", "label", "circle", "circle"]);
});

test("# offers only labels, matched on their name", () => {
  assert.deepEqual(suggestions("#", data).map(s => s.text), ["#travel", "#paperwork"]);
  const [s] = suggestions("#pap", data);
  assert.equal(s.value, "paperwork");
  assert.deepEqual(s.ranges, [[1, 4]]);
});

test("text matches filters and headings, best first (shorter on a tie), each heading once", () => {
  assert.deepEqual(suggestions("p", data).map(s => s.text), ["Private", "Packing", "Permanent", "#paperwork"]);
  assert.deepEqual(suggestions("trip", data).map(s => s.text), ["Trip to Lisbon"]);
  assert.deepEqual(suggestions("trl", data).map(s => s.text), ["Trip to Lisbon", "#travel"]);
  assert.equal(suggestions("trip to lisbon", data).length, 0);
});

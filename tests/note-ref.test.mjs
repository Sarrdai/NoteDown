// Unit tests for the note address (app/js/core/note-ref.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { refOf, assignRefs } from "../app/js/core/note-ref.js";

test("the first holder of an id keeps it, later files get id@circleKey, and it can be taken back", () => {
  const [a, b, c] = [{ id: "x" }, { id: "x" }, { id: "y" }];
  assignRefs([{ key: "", notes: [c] }, { key: "bob", notes: [a] }, { key: "lea", notes: [b] }]);
  assert.deepEqual([a, b, c].map(refOf), ["x", "x@lea", "y"]);
  assignRefs([{ key: "lea", notes: [b] }]);
  assert.equal(refOf(b), "x", "no longer a duplicate: its address is its id again");
});

test("the address is not enumerable: copies and files don't carry it", () => {
  const a = { id: "x", body: "A" }, b = { id: "x", body: "B" };
  assignRefs([{ key: "bob", notes: [a] }, { key: "lea", notes: [b] }]);
  assert.equal(refOf(b), "x@lea");
  assert.equal(JSON.stringify(b), '{"id":"x","body":"B"}');
  assert.equal(refOf({ ...b }), "x");
});

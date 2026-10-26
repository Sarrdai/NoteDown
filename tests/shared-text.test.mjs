import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedNoteBody } from "../app/js/core/shared-text.js";

test("sharedNoteBody: the subject becomes the heading, the text the body", () => {
  assert.equal(sharedNoteBody({ subject: "Grandma's recipe box", text: "https://recipes.example.com/lentil-soup" }),
    "## Grandma's recipe box\n\nhttps://recipes.example.com/lentil-soup");
});

test("sharedNoteBody: without a subject only the text, trimmed, line ends unified", () => {
  assert.equal(sharedNoteBody({ text: "  Oat milk\r\nCoffee beans\n" }), "Oat milk\nCoffee beans");
  assert.equal(sharedNoteBody({ text: "Oat milk", subject: "  " }), "Oat milk");
});

test("sharedNoteBody: a subject on one line, not repeated when the text starts with it", () => {
  assert.equal(sharedNoteBody({ subject: "Trip to\nLisbon", text: "" }), "## Trip to Lisbon");
  assert.equal(sharedNoteBody({ subject: "Trip to Lisbon", text: "Trip to Lisbon\nTram 28" }), "Trip to Lisbon\nTram 28");
});

test("sharedNoteBody: nothing shared gives an empty body", () => {
  assert.equal(sharedNoteBody({}), "");
  assert.equal(sharedNoteBody({ text: " \n ", subject: null }), "");
});

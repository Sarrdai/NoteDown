import { test } from "node:test";
import assert from "node:assert/strict";
import { ratingAt, ratingStart, ratings, setRating, newRating, ratingHtml } from "../app/js/core/rating.js";

test("recognizes filled stars followed by empty ones", () => {
  assert.deepEqual(ratingAt("★★★☆☆ rest"), { raw: "★★★☆☆", value: 3, size: 5 });
  assert.equal(ratingAt("★★★").value, 3);
  assert.equal(ratingAt("☆☆☆").value, 0);
});

test("rejects mixed order, too short and too long runs", () => {
  assert.equal(ratingAt("★★☆★"), null);
  assert.equal(ratingAt("★"), null);
  assert.equal(ratingAt("★☆"), null);
  assert.equal(ratingAt("★".repeat(11)), null);
  assert.equal(ratingStart("no stars"), -1);
  assert.equal(ratingStart("Rating: ★★★★☆"), 8);
});

test("finds ratings outside code only", () => {
  const body = "a ★★☆☆☆\n`★★★☆☆`\n```\n★★★★★\n```\n☆☆☆";
  const r = ratings(body);
  assert.equal(r.length, 2);
  assert.equal(body.slice(r[0].from, r[0].to), "★★☆☆☆");
  assert.equal(body.slice(r[1].from, r[1].to), "☆☆☆");
});

test("setRating sets, keeps the length and clears on the current value", () => {
  assert.equal(setRating("x ★★★☆☆ y", 0, 2), "x ★★☆☆☆ y");
  assert.equal(setRating("x ★★★☆☆ y", 0, 5), "x ★★★★★ y");
  assert.equal(setRating("x ★★★☆☆ y", 0, 3), "x ☆☆☆☆☆ y");
  assert.equal(setRating("☆☆☆\n★★★★", 1, 1), "☆☆☆\n★☆☆☆");
  assert.equal(setRating("abc", 0, 1), "abc");
});

test("newRating adds a space when glued to text", () => {
  assert.equal(newRating(""), "☆☆☆☆☆");
  assert.equal(newRating("a "), "☆☆☆☆☆");
  assert.equal(newRating("a"), " ☆☆☆☆☆");
});

test("ratingHtml has one button per star", () => {
  const h = ratingHtml({ value: 2, size: 4 });
  assert.equal(h.match(/<button/g).length, 4);
  assert.match(h, /Rating 2 of 4/);
});

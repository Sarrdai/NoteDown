import { test } from "node:test";
import assert from "node:assert/strict";
import { showStorageHint, HINT_PAUSE_DAYS } from "../app/js/core/storage-hint.js";

const web = { native: false, syncOn: false, hiddenOn: null, today: "2026-10-15" };

test("shows in a browser with sync off", () => {
  assert.equal(showStorageHint(web), true);
});

test("never in the app or with sync on", () => {
  assert.equal(showStorageHint({ ...web, native: true }), false);
  assert.equal(showStorageHint({ ...web, syncOn: true }), false);
});

test("hidden for HINT_PAUSE_DAYS, then back (across a month end)", () => {
  assert.equal(HINT_PAUSE_DAYS, 14);
  assert.equal(showStorageHint({ ...web, hiddenOn: "2026-10-15" }), false);
  assert.equal(showStorageHint({ ...web, hiddenOn: "2026-10-02" }), false);
  assert.equal(showStorageHint({ ...web, hiddenOn: "2026-10-01" }), true);
  assert.equal(showStorageHint({ ...web, hiddenOn: "2026-09-30", today: "2026-10-13" }), false);
  assert.equal(showStorageHint({ ...web, hiddenOn: "2026-09-30", today: "2026-10-14" }), true);
});

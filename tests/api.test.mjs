// The readable messages of ApiError (app/js/sync/api.js) for the server's limit answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../app/js/sync/api.js";

test("429 and the storage quota answer get readable messages and keep their status", () => {
  const rate = new ApiError(429, { detail: "too many requests" });
  assert.equal(rate.status, 429);
  assert.equal(rate.message, "Too many attempts. Try again later.");
  const quota = new ApiError(413, { detail: "storage quota exceeded" });
  assert.equal(quota.status, 413);
  assert.equal(quota.message, "Sync storage is full.");
});

test("other answers keep status and detail", () => {
  assert.equal(new ApiError(413, { detail: "too many files" }).message, "413: too many files");
  assert.equal(new ApiError(409, { detail: "version conflict", version: 2 }).message, "409: version conflict");
  assert.equal(new ApiError(500, null).message, "HTTP 500");
});

test("createApis: one client per server, the same one for the same address", async () => {
  const { createApis } = await import("../app/js/sync/api.js");
  const apis = createApis(() => ({}));
  assert.equal(apis("https://a.test/api"), apis("https://a.test/api/"));
  assert.notEqual(apis("https://a.test/api"), apis("https://b.test/api"));
  apis.forgetTokens();
});

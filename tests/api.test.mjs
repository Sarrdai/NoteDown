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

test("news methods map to the news endpoints and listFiles passes the news version and the member limit through", async () => {
  const { createApi } = await import("../app/js/sync/api.js");
  const { generateDeviceKeys } = await import("../app/js/core/crypto.js");
  const keys = await generateDeviceKeys();
  const calls = [];
  const answers = {
    "GET /v1/auth/challenge": { challenge: "abc" },
    "POST /v1/auth/token": { token: "t", expires: Math.floor(Date.now() / 1000) + 3600 },
    "GET /v1/files": { files: [], quota: 5, max_members: 7, news: "v1" },
    "GET /v1/news": { version: "v1", news: [] },
    "GET /v1/admin/news": { news: [] },
    "POST /v1/admin/news": { id: "i", created: "c", modified: "m" },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, { method, body }) => {
    const path = new URL(url).pathname;
    calls.push([method, path, body && JSON.parse(body)]);
    const answer = answers[`${method} ${path}`];
    return answer === undefined
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const api = createApi("https://s.test", () => ({ identity: "id", device: "dev", sign: keys.sign.privateKey }));
    assert.deepEqual(await api.listFiles(), { files: [], quota: 5, maxMembers: 7, epoch: null, news: "v1", deleted: [] });
    assert.deepEqual(await api.news(), { version: "v1", news: [] });
    await api.adminNews();
    assert.equal((await api.adminCreateNews("## A")).id, "i");
    await api.adminUpdateNews("i", { archived: true });
    await api.adminDeleteNews("i");
    const sent = calls.filter(([, path]) => path.startsWith("/v1/news") || path.startsWith("/v1/admin/news"));
    assert.deepEqual(sent, [
      ["GET", "/v1/news", undefined],
      ["GET", "/v1/admin/news", undefined],
      ["POST", "/v1/admin/news", { body: "## A" }],
      ["PUT", "/v1/admin/news/i", { archived: true }],
      ["DELETE", "/v1/admin/news/i", undefined],
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a block and a deletion get readable messages", () => {
  assert.equal(new ApiError(423, { detail: "identity is blocked", until: null }).message, "Sync is blocked by the server's owner.");
  assert.match(new ApiError(423, { detail: "identity is blocked", until: "2026-10-20T08:00:00+00:00" }).message, /^Sync is blocked by the server's owner until \d+ Oct 2026\.$/);
  assert.equal(new ApiError(410, { detail: "identity deleted" }).message, "Your sync data was deleted from the server.");
});

test("deleteWithRecoveryKey signs a challenge with the identity key, for this server and identity only", async () => {
  const { deleteWithRecoveryKey } = await import("../app/js/sync/delete-identity.js");
  const c = await import("../app/js/core/crypto.js");
  const { generateRecoveryKey } = await import("../app/js/core/sharing.js");
  const key = generateRecoveryKey();
  const { identity } = await c.deriveRecovery(c.recoveryKeyBytes(key));
  const id = await c.keyId(identity.publicKey);
  const sent = [];
  const api = { host: "api.example", challenge: async () => ({ challenge: "abc" }), deleteIdentity: async (...args) => { sent.push(args); } };
  assert.equal(await deleteWithRecoveryKey(api, key.toLowerCase()), id);
  const [[to, challenge, sig]] = sent;
  assert.deepEqual([to, challenge], [id, "abc"]);
  const publicKey = await crypto.subtle.importKey("raw", identity.publicKey, { name: "Ed25519" }, false, ["verify"]);
  const signedFor = server => crypto.subtle.verify({ name: "Ed25519" }, publicKey, c.fromB64u(sig, 64), c.deletionMessage({ server, identity: id, challenge: "abc" }));
  assert.ok(await signedFor("api.example"));
  assert.equal(await signedFor("evil.example"), false, "another server can't pass it on (security review H1)");
  await assert.rejects(deleteWithRecoveryKey(api, key, "someone-else"), /not the recovery key/);
  await assert.rejects(deleteWithRecoveryKey(api, "nonsense"), /doesn't look like a recovery key/);
  const missing = { ...api, deleteIdentity: async () => { throw Object.assign(new Error("404"), { status: 404 }); } };
  await assert.rejects(deleteWithRecoveryKey(missing, key), /No notes are synced/);
});

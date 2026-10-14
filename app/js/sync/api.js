// The sync server's HTTP API (docs/server-api.md → "Endpoints"): one method
// per endpoint, JSON in and out. Authenticated calls get a bearer token, which
// is fetched by signing a challenge and kept until shortly before it expires.
import { signChallenge } from "../core/crypto.js";

// The server's answers that get a sentence of their own in the sync status.
function describe(status, body) {
  if (status === 429) return "Too many attempts. Try again later.";
  if (status === 413 && body && body.detail === "storage quota exceeded") return "Sync storage is full.";
  return body && body.detail ? `${status}: ${body.detail}` : `HTTP ${status}`;
}

/** A non-2xx answer: `status` and the parsed body (`detail`, maybe `version` / `seq`). */
export class ApiError extends Error {
  constructor(status, body) {
    super(describe(status, body));
    this.status = status;
    this.body = body || {};
  }
}

/** The server could not be reached (no connection, DNS, CORS). */
export class NetworkError extends Error {}

/**
 * An API client for `baseUrl`. `who()` returns the caller for authenticated
 * calls: `{ identity, device, sign }` (`sign` = the device's Ed25519 private key).
 */
export function createApi(baseUrl, who) {
  let token = null;      // { value, expires (ms), device }

  async function call(method, path, body, auth = false, retry = true) {
    const headers = body === undefined ? {} : { "Content-Type": "application/json" };
    if (auth) headers.Authorization = "Bearer " + await bearer();
    let res;
    try {
      res = await fetch(baseUrl.replace(/\/$/, "") + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store",
      });
    } catch (e) {
      throw new NetworkError("Can't reach the sync server. Check your connection and try again.");
    }
    if (res.status === 401 && auth && retry) { token = null; return call(method, path, body, auth, false); }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }

  async function bearer() {
    const me = who();
    if (token && token.device === me.device && token.expires - 60000 > Date.now()) return token.value;
    const { challenge } = await call("GET", "/v1/auth/challenge");
    const sig = await signChallenge(me.sign, challenge);
    const res = await call("POST", "/v1/auth/token", { identity: me.identity, device: me.device, challenge, sig });
    token = { value: res.token, expires: res.expires * 1000, device: me.device };
    return token.value;
  }

  return {
    createIdentity: (identityKey, entries) => call("POST", "/v1/identities", { identity_key: identityKey, entries }),
    getIdentity: id => call("GET", `/v1/identities/${id}`),
    appendEntry: (id, entry) => call("POST", `/v1/identities/${id}/entries`, { entry }, true),
    listFiles: () => call("GET", "/v1/files", undefined, true).then(({ files, quota }) => ({ files, quota })),   // each file with its `size`
    getFile: id => call("GET", `/v1/files/${id}`, undefined, true),
    putFile: (id, body) => call("PUT", `/v1/files/${id}`, body, true),
    addKeys: (id, keys) => call("POST", `/v1/files/${id}/keys`, { keys }, true),
    createSlot: () => call("POST", "/v1/relay"),
    fillSlot: (slot, payload) => call("PUT", `/v1/relay/${slot}`, { payload }, true),
    readSlot: slot => call("GET", `/v1/relay/${slot}`).then(r => r && r.payload),   // null while empty
    forgetToken: () => { token = null; },
  };
}

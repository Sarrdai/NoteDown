// The sync server's HTTP API (docs/server-api.md → "Endpoints"): one method
// per endpoint, JSON in and out. Authenticated calls get a bearer token, which
// is fetched by signing a challenge and kept until shortly before it expires.
import { signChallenge } from "../core/crypto.js";
import { backupFileName } from "../core/admin.js";
import { blockedMessage } from "../core/sync-state.js";

/**
 * This app's compatibility level, sent with every request (docs/server-api.md → "App versions", backlog #51).
 * Raised together with the server's MIN_CLIENT when a change ships that older apps can't read or would break.
 */
export const CLIENT_LEVEL = 2;

// The server's answers that get a sentence of their own in the sync status.
function describe(status, body) {
  if (status === 426) return "This version of NoteDown is too old to sync. Update the app.";
  if (status === 429) return "Too many attempts. Try again later.";
  if (status === 413 && body && body.detail === "storage quota exceeded") return "Sync storage is full.";
  if (status === 423) return blockedMessage(body?.until ?? null);
  if (status === 410) return "Your sync data was deleted from the server.";
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
    const headers = { "NoteDown-Client": String(CLIENT_LEVEL) };
    if (body !== undefined) headers["Content-Type"] = "application/json";
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
    challenge: () => call("GET", "/v1/auth/challenge"),   // → { challenge }
    // Signed with the identity key (the recovery key), no token: works without a device and while blocked.
    deleteIdentity: (id, challenge, sig) => call("POST", `/v1/identities/${id}/delete`, { challenge, sig }),
    // Authenticated; `invitation` names an open invitation of `id` (the way to read a stranger's list).
    getIdentity: (id, invitation) => call(
      "GET", `/v1/identities/${id}` + (invitation ? `?invitation=${encodeURIComponent(invitation)}` : ""), undefined, true),
    appendEntry: (id, entry) => call("POST", `/v1/identities/${id}/entries`, { entry }, true),
    listFiles: () => call("GET", "/v1/files", undefined, true).then(({ files, quota, max_members, epoch, news, deleted }) => ({ files, quota, maxMembers: max_members ?? null, epoch: epoch ?? null, news: news ?? null, deleted: deleted ?? [] })),   // each file with its `size`; `maxMembers` the most members a file this identity creates may have; `epoch` changes when the server was restored, `news` with every change to the news posts, `deleted`: the deleted identities among the members
    // The owner's news posts, unencrypted, the same for everybody: → { version, news: [{ id, created, modified, body }] }
    news: () => call("GET", "/v1/news", undefined, true),
    getFile: id => call("GET", `/v1/files/${id}`, undefined, true),
    putFile: (id, body) => call("PUT", `/v1/files/${id}`, body, true),
    addKeys: (id, keys) => call("POST", `/v1/files/${id}/keys`, { keys }, true),
    // Version history (docs/server-api.md → "Version history"): → { key_gen, versions: [{ version, updated, replaced, size, key_gen, pinned, saved }], chain: [{ gen, sealed }] }
    fileVersions: id => call("GET", `/v1/files/${id}/versions`, undefined, true),
    saveVersion: id => call("POST", `/v1/files/${id}/versions`, undefined, true),   // "Back up now" → { version, saved: false when stored already }
    fileVersion: (id, version) => call("GET", `/v1/files/${id}/versions/${version}`, undefined, true),   // → { id, version, ciphertext, key_gen }
    // Contacts and invitations (docs/server-api.md → "Contacts and invitations").
    createInvitation: (id, kind, sig) => call("POST", "/v1/invitations", { id, kind, sig }, true),   // → { expires }
    listInvitations: () => call("GET", "/v1/invitations", undefined, true).then(r => r.invitations),
    deleteInvitation: id => call("DELETE", `/v1/invitations/${id}`, undefined, true),
    sendRequest: (id, cards) => call("POST", `/v1/invitations/${id}/request`, { cards }, true),
    listContacts: () => call("GET", "/v1/contacts", undefined, true).then(r => r.contacts),
    confirmContact: invitation => call("POST", "/v1/contacts", { invitation }, true),   // → { identity }
    removeContact: id => call("DELETE", `/v1/contacts/${id}`, undefined, true),
    createSlot: kem => call("POST", "/v1/relay", { kem }),   // kem: the new device's ML-KEM key (b64u)
    slotKem: slot => call("GET", `/v1/relay/${slot}/kem`).then(r => r.kem),
    fillSlot: (slot, payload) => call("PUT", `/v1/relay/${slot}`, { payload }, true),
    readSlot: slot => call("GET", `/v1/relay/${slot}`).then(r => r && r.payload),   // null while empty
    forgetToken: () => { token = null; },
    // The server owner's maintenance endpoints (app/admin/); any other caller gets 404.
    adminOverview: () => call("GET", "/v1/admin/overview", undefined, true),
    adminIdentities: () => call("GET", "/v1/admin/identities", undefined, true),
    adminIdentity: id => call("GET", `/v1/admin/identities/${encodeURIComponent(id)}`, undefined, true),
    adminSetQuota: (id, quota) => call("PUT", `/v1/admin/identities/${encodeURIComponent(id)}/quota`, { quota }, true),   // quota in bytes, null = default
    adminSetMaxMembers: max => call("PUT", "/v1/admin/max-members", { max_members: max }, true),   // the server-wide limit, null = default
    adminSetIdentityMaxMembers: (id, max) => call("PUT", `/v1/admin/identities/${encodeURIComponent(id)}/max-members`, { max_members: max }, true),   // null = the server-wide limit
    adminSetHistory: (id, on) => call("PUT", `/v1/admin/identities/${encodeURIComponent(id)}/history`, { history: on }, true),   // on: boolean
    // until: an ISO time with zone, or null for a block without an end; blocked false lifts it.
    adminBlock: (id, blocked, until = null) => call("PUT", `/v1/admin/identities/${encodeURIComponent(id)}/block`, { blocked, ...(until && { until }) }, true),
    adminDeleteIdentity: id => call("DELETE", `/v1/admin/identities/${encodeURIComponent(id)}`, undefined, true),
    adminNews: () => call("GET", "/v1/admin/news", undefined, true),   // → { news: [{ id, created, modified, body, archived }] }, newest first
    adminCreateNews: body => call("POST", "/v1/admin/news", { body }, true),   // → { id, created, modified }; 409 "too many news"
    adminUpdateNews: (id, patch) => call("PUT", `/v1/admin/news/${encodeURIComponent(id)}`, patch, true),   // patch: { body?, archived? }
    adminDeleteNews: id => call("DELETE", `/v1/admin/news/${encodeURIComponent(id)}`, undefined, true),
    adminRestore: backup => call("POST", "/v1/admin/restore", backup, true),   // → { identities, files }
    // → { text (the backup as sent), filename (from Content-Disposition, else notedown-backup-<date>.json) }
    adminBackup: async () => {
      for (let retry = true; ; retry = false) {
        const headers = { Authorization: "Bearer " + await bearer() };
        let res;
        try {
          res = await fetch(baseUrl.replace(/\/$/, "") + "/v1/admin/backup", { headers, cache: "no-store" });
        } catch (e) {
          throw new NetworkError("Can't reach the sync server. Check your connection and try again.");
        }
        if (res.status === 401 && retry) { token = null; continue; }
        if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
        return { text: await res.text(), filename: backupFileName(res.headers.get("Content-Disposition")) };
      }
    },
  };
}

/**
 * One API client per server (docs/sync-and-sharing.md → "Servers"): `clients(url)` is the client of the
 * server at `url`, made on first use and kept, each with its own token. `forgetTokens()` signs all out.
 */
export function createApis(who) {
  const byUrl = new Map();
  const clients = url => {
    const key = url.replace(/\/+$/, "");
    if (!byUrl.has(key)) byUrl.set(key, createApi(key, who));
    return byUrl.get(key);
  };
  clients.forgetTokens = () => byUrl.forEach(api => api.forgetToken());
  return clients;
}

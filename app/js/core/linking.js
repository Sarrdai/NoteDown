// Linking a device by QR code (docs/server-api.md → "Linking a device"): the
// code the new device shows, the message the linked device leaves for it in
// the relay slot, and the name a device suggests for itself; also the
// invitation link of a contact request and its card (→ "Contacts and
// invitations"). No I/O.

const PREFIX = "notedown:link?";
const KEY = /^[A-Za-z0-9_-]{43}$/;     // b64u of 32 bytes
const SLOT = /^[A-Za-z0-9_-]{22}$/;    // b64u of 16 bytes
export const MAX_NAME = 40;

/**
 * A server address in its one written form (no trailing slash), "" for none; null when the text is not
 * an http(s) address. Links, link codes, relay messages and contact markers name servers this way; a
 * missing one means the default server (the app's configured API address).
 */
export function serverUrl(text) {
  if (text === undefined || text === null || text === "") return "";
  if (typeof text !== "string") return null;
  try {
    const u = new URL(text.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return (u.origin + u.pathname).replace(/\/+$/, "") + u.search;
  } catch {
    return null;
  }
}

const cleanName = name => (typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME) : "");

const withServer = (params, server) => (server ? { ...params, srv: serverUrl(server) } : params);

/**
 * The text of the new device's QR code: relay slot, public device keys (b64u; `kem` the SHA-256 of its ML-KEM key,
 * which waits at the slot), its suggested name and the server the slot is on (`server`).
 */
export function linkCode({ slot, sign, enc, kem, name, server }) {
  return PREFIX + new URLSearchParams(withServer({ v: "1", slot, sign, enc, kem, name: cleanName(name) }, server));
}

/** `{ slot, sign, enc, kem, name, server }` of a scanned link code (`server` "" = the default server), or null when the text is not one. */
export function parseLinkCode(text) {
  if (typeof text !== "string" || !text.startsWith(PREFIX)) return null;
  const p = new URLSearchParams(text.slice(PREFIX.length));
  const [slot, sign, enc, kem] = ["slot", "sign", "enc", "kem"].map(k => p.get(k) || "");
  if (p.get("v") !== "1" || !SLOT.test(slot) || ![sign, enc, kem].every(k => KEY.test(k))) return null;
  const server = serverUrl(p.get("srv") || "");
  if (server === null) return null;
  return { slot, sign, enc, kem, name: cleanName(p.get("name")), server };
}

/** What the linked device seals into the slot: the identity's ID, the user's display name and the identity's home server. */
export function relayMessage(identity, name, server) {
  return { v: 1, identity, name: cleanName(name), ...(server && { server: serverUrl(server) }) };
}

/** `{ identity, name, server }` of an opened relay message (`server` "" = the default server), or null when it is malformed. */
export function parseRelayMessage(message) {
  if (!message || message.v !== 1 || typeof message.identity !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(message.identity)) return null;
  const server = serverUrl(message.server);
  if (server === null) return null;
  return { identity: message.identity, name: cleanName(message.name), server };
}

// ---------- contact invitations ----------

const ID = /^[A-Za-z0-9_-]{22}$/;   // b64u of 16 bytes: identity IDs and invitation secrets
const INVITE_LINK = /https?:\/\/[^\s#]*\/invite\/?#\S+/i;

/** The invitation link (also the text of the "My code" QR code): `<web>/invite/#v=1&id=<identity>&s=<secret>&name=<name>&srv=<home server>`. */
export function invitationLink({ web, identity, secret, name, server }) {
  return `${web.replace(/\/+$/, "")}/invite/#` + new URLSearchParams(withServer({ v: "1", id: identity, s: secret, name: cleanName(name) }, server));
}

/**
 * `{ identity, secret, name, server }` of an invitation link (`server`: the inviter's home server, "" = the default), or null when the text holds none. Surrounding
 * whitespace and text around the link (a messenger's greeting) are ignored; the part before `/invite/`
 * is not checked, so a link of any copy of the app (web, Android, a local test server) is read.
 */
export function parseInvitationLink(text) {
  const link = typeof text === "string" ? INVITE_LINK.exec(text.trim()) : null;
  if (!link) return null;
  const p = new URLSearchParams(link[0].slice(link[0].indexOf("#") + 1));
  const [identity, secret] = [p.get("id") || "", p.get("s") || ""];
  if (p.get("v") !== "1" || !ID.test(identity) || !ID.test(secret)) return null;
  const server = serverUrl(p.get("srv") || "");
  if (server === null) return null;
  return { identity, secret, name: cleanName(p.get("name")), server };
}

/** The card a requester seals for the inviter's devices: who they are and the secret that proves they had the link. */
export function contactCard(identity, name, secret) {
  return { v: 1, identity, name: cleanName(name), secret };
}

/** `{ identity, name, secret }` of an opened card, or null when it is malformed. */
export function parseContactCard(card) {
  if (!card || card.v !== 1 || !ID.test(card.identity) || !ID.test(card.secret)) return null;
  return { identity: card.identity, name: cleanName(card.name), secret: card.secret };
}

// ---------- device names ----------

const BROWSERS = [[/EdgA?\//, "Edge"], [/OPR\//, "Opera"], [/SamsungBrowser\//, "Samsung Internet"], [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\//, "Chrome"], [/Safari\//, "Safari"]];
const SYSTEMS = [[/Android/, "Android"], [/iPhone/, "iPhone"], [/iPad/, "iPad"], [/Windows/, "Windows"], [/CrOS/, "ChromeOS"],
  [/Mac OS X|Macintosh/, "Mac"], [/Linux/, "Linux"]];

/**
 * The name a device suggests for itself from its user agent: "Chrome on
 * Windows", "Firefox on Android"; the Android app (its web view, "; wv)")
 * is "NoteDown app on Android".
 */
export function deviceLabel(userAgent = "") {
  const system = SYSTEMS.find(([re]) => re.test(userAgent))?.[1];
  if (/; wv\)/.test(userAgent)) return "NoteDown app" + (system ? " on " + system : "");
  const browser = BROWSERS.find(([re]) => re.test(userAgent))?.[1] || "Browser";
  return system ? `${browser} on ${system}` : browser;
}

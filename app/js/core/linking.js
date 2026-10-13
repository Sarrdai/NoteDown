// Linking a device by QR code (docs/server-api.md → "Linking a device"): the
// code the new device shows, the message the linked device leaves for it in
// the relay slot, and the name a device suggests for itself. No I/O.

const PREFIX = "notedown:link?";
const KEY = /^[A-Za-z0-9_-]{43}$/;     // b64u of 32 bytes
const SLOT = /^[A-Za-z0-9_-]{22}$/;    // b64u of 16 bytes
export const MAX_NAME = 40;

const cleanName = name => (typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME) : "");

/** The text of the new device's QR code: relay slot, public device keys (b64u) and its suggested name. */
export function linkCode({ slot, sign, enc, name }) {
  return PREFIX + new URLSearchParams({ v: "1", slot, sign, enc, name: cleanName(name) });
}

/** `{ slot, sign, enc, name }` of a scanned link code, or null when the text is not one. */
export function parseLinkCode(text) {
  if (typeof text !== "string" || !text.startsWith(PREFIX)) return null;
  const p = new URLSearchParams(text.slice(PREFIX.length));
  const [slot, sign, enc] = ["slot", "sign", "enc"].map(k => p.get(k) || "");
  if (p.get("v") !== "1" || !SLOT.test(slot) || !KEY.test(sign) || !KEY.test(enc)) return null;
  return { slot, sign, enc, name: cleanName(p.get("name")) };
}

/** What the linked device seals into the slot: the identity's ID and the user's display name. */
export function relayMessage(identity, name) {
  return { v: 1, identity, name: cleanName(name) };
}

/** `{ identity, name }` of an opened relay message, or null when it is malformed. */
export function parseRelayMessage(message) {
  if (!message || message.v !== 1 || typeof message.identity !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(message.identity)) return null;
  return { identity: message.identity, name: cleanName(message.name) };
}

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

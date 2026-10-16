// External content in notes (backlog #30): images and videos embedded from
// other hosts, and links. What this device does with them is a setting of
// this device only, never synced — a note anyone of a circle (or someone
// with access to one of the user's devices) wrote must not make the other
// devices contact a host by itself. A device-wide default, overridable per
// circle (Private, each contact, each group).

/** Media: load by itself, show a tile with the address to tap, or only a placeholder. */
export const MEDIA = ["auto", "click", "never"];
/** Links: open at once, ask first (showing the real target), or plain text. */
export const LINKS = ["open", "confirm", "off"];

export const DEFAULT_EXTERNAL = { media: "click", links: "confirm", circles: {} };

const VIDEO = /\.(mp4|webm|ogv|mov|m4v)$/i;

/** What applies to a circle (circleKey, "" = private): its own choice, else the default. */
export function externalPolicy(settings, key) {
  const s = { ...DEFAULT_EXTERNAL, ...settings };
  const own = (key != null && s.circles[key]) || {};
  return { media: own.media || s.media, links: own.links || s.links };
}

/** Sets (or with `null` clears) one circle's choice for `kind` ("media" | "links"); returns new settings. */
export function setCirclePolicy(settings, key, kind, value) {
  const s = { ...DEFAULT_EXTERNAL, ...settings };
  const own = { ...s.circles[key] };
  if (value) own[kind] = value;
  else delete own[kind];
  const circles = { ...s.circles };
  if (Object.keys(own).length) circles[key] = own;
  else delete circles[key];
  return { ...s, circles };
}

/** An embedded file the app may load: an http(s) address, else null (a data: or javascript: one is never loaded). */
export function mediaSource(src) {
  try {
    const url = new URL(src);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch { return null; }
}

/** "image" or "video", by the file's extension. */
export function mediaKind(src) {
  try { return VIDEO.test(new URL(src).pathname) ? "video" : "image"; } catch { return "image"; }
}

/** The address split for display, the host to stand out: { before, host, after }; the whole text as `after` when it is no URL. */
export function splitAddress(href) {
  const m = /^([a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?)([^/?#:]+)(.*)$/i.exec(href);
  return m ? { before: m[1], host: m[2], after: m[3] } : { before: "", host: "", after: href };
}

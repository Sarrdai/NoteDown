// The NoteDown file: one Markdown file holding every note, open and closed.
// Each note starts with a marker comment that carries its metadata and runs
// until the next marker (docs/file-format.md):
//
//   <!-- note id=n1 status=open created=2026-10-01T09:12 modified=2026-10-12T18:03 due=2026-10-15 -->
//   ## Shopping
//   - [ ] Milk
//
// Text before the first marker is kept as the file's preamble. A note that
// was moved to another file (sharing) leaves a bodyless marker with `moved=`;
// the private file also names the user's devices in `<!-- device … -->` markers
// and holds the user's contacts in `<!-- contact … -->` markers; a shared file names its
// members in `<!-- member … -->` markers, and a note someone left carries `left=<ids>`.
// A deleted note waits in the trash of the private file for 30 days: it carries `deleted=<time>` and, when it
// came from a shared file, `kept=<circleKey>` of that circle. Removing such a note for good leaves a bodyless
// `purged=<time>` marker, and each device marker carries the time the device last synced (`synced=`).
// An `<!-- order … -->` marker holds a custom note order: the user's own in
// the private file, a circle's shared one in a shared file. `<!-- news … -->`
// markers in the private file remember which news posts the user has seen,
// archived or deleted (core/news.js). A note's `color=` and `decor=` are its
// look (core/look.js); a private copy of a shared note names its original in
// `copyof=` and the original's `modified` it took its text from in `copied=` (core/note-links.js);
// a note imported from Google Keep names its origin in `keep=` (core/keep-import.js). `<!-- source … -->`
// markers in the private file name the user's folder sources, and a note read from one names it in `source=`
// (core/folder-source.js).
import { validColor, validDecor } from "./look.js";

const MARKER = /^<!-- (note|device|contact|member|news|source|order) ((?:[a-z]+=\S+ ?)*)-->$/;

/** Parses a NoteDown file into { preamble, notes, moved, purged, devices, contacts, members, news, sources, order }
 *  (`purged`: [{ id, purged }], `devices`: [{ id, name?, title?, synced? }], `members`: [{ id, name }] of a shared file, `contacts`: [{ id, name, color, server?, pending?, verified? }],
 *  `news`: [{ id, seen, status? }], `sources`: [{ id, name }], `order`: { ids, modified } or null). */
export function parseNotesFile(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const notes = [];
  const moved = [];
  const purged = [];
  const devices = [];
  const contacts = [];
  const members = [];
  const news = [];
  const sources = [];
  let order = null;
  const finish = c => {
    if (c.kind === "order") { if (c.meta.modified) order = { ids: c.meta.ids ? c.meta.ids.split(",") : [], modified: c.meta.modified }; }
    else if (c.kind === "contact") { if (c.meta.id && c.meta.name) contacts.push(finishContact(c.meta)); }
    else if (c.kind === "member") { if (c.meta.id && c.meta.name) members.push({ id: c.meta.id, name: decodeName(c.meta.name) }); }
    else if (c.kind === "news") { if (c.meta.id && c.meta.seen) news.push(finishNews(c.meta)); }
    else if (c.kind === "source") { if (c.meta.id && c.meta.name) sources.push({ id: c.meta.id, name: decodeName(c.meta.name) }); }
    else if (c.kind === "device") { if (c.meta.id && (c.meta.name || c.meta.title || c.meta.synced)) devices.push(finishDevice(c.meta)); }
    else if (c.meta.moved && c.meta.id) moved.push({ id: c.meta.id, moved: c.meta.moved, ...(c.meta.to && { to: c.meta.to.split("+") }) });
    else if (c.meta.purged && c.meta.id) purged.push({ id: c.meta.id, purged: c.meta.purged });
    else notes.push(finishNote(c));
  };
  const preamble = [];
  let current = null;
  for (const line of lines) {
    const m = MARKER.exec(line.trim());
    if (m) {
      if (current) finish(current);
      current = { kind: m[1], meta: parseAttrs(m[2]), body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) finish(current);
  return { preamble: preamble.join("\n").trim(), notes, moved, purged, devices, contacts, members, news, sources, order };
}

/** Writes { preamble, notes, moved, purged, devices, contacts, members, news, sources, order } back into the file format. */
export function serializeNotesFile({ preamble = "", notes, moved = [], purged = [], devices = [], contacts = [], members = [], news = [], sources = [], order = null }) {
  const parts = preamble ? [preamble] : [];
  for (const n of notes) parts.push(`${noteMarker(n)}\n${n.body.trim()}`);
  for (const m of moved) parts.push(`<!-- note id=${m.id} moved=${m.moved}${m.to ? ` to=${m.to.join("+")}` : ""} -->`);
  for (const m of purged) parts.push(`<!-- note id=${m.id} purged=${m.purged} -->`);
  for (const m of members) parts.push(`<!-- member id=${m.id} name=${encodeURIComponent(m.name)} -->`);
  for (const d of devices) parts.push(`<!-- device id=${d.id}${d.name ? " name=" + encodeURIComponent(d.name) : ""}${d.title ? " title=" + encodeURIComponent(d.title) : ""}${d.synced ? " synced=" + d.synced : ""} -->`);
  for (const c of contacts) {
    parts.push(`<!-- contact id=${c.id} name=${encodeURIComponent(c.name)} color=${c.color}${c.server ? " server=" + encodeURIComponent(c.server) : ""}${c.pending ? " pending=" + c.pending : ""}${c.verified ? " verified=" + c.verified : ""} -->`);
  }
  for (const m of news) parts.push(`<!-- news id=${m.id} seen=${m.seen}${m.status ? " status=" + m.status : ""} -->`);
  for (const s of sources) parts.push(`<!-- source id=${s.id} name=${encodeURIComponent(s.name)} -->`);
  if (order) parts.push(`<!-- order modified=${order.modified}${order.ids.length ? " ids=" + order.ids.join(",") : ""} -->`);
  return parts.join("\n\n") + "\n";
}

/** A note's marker line, `<!-- note id=… status=… … -->`. */
export function noteMarker(n) {
  const attrs = ["id=" + n.id, "status=" + n.status, "created=" + n.created, "modified=" + n.modified];
  if (n.due) attrs.push("due=" + n.due);
  if (n.closed) attrs.push("closed=" + n.closed);
  if (n.color) attrs.push("color=" + n.color);
  if (n.decor) attrs.push("decor=" + n.decor);
  if (n.left && n.left.length) attrs.push("left=" + n.left.join(","));
  if (n.deleted) attrs.push("deleted=" + n.deleted);
  if (n.kept) attrs.push("kept=" + n.kept);
  if (n.from) attrs.push("from=" + n.from);
  if (n.copyof) attrs.push("copyof=" + n.copyof);
  if (n.copied) attrs.push("copied=" + n.copied);
  if (n.keep) attrs.push("keep=" + n.keep);
  if (n.source) attrs.push("source=" + n.source);
  return `<!-- note ${attrs.join(" ")} -->`;
}

/** A new open note; `now` is a timestamp (see timestamp()). */
export function createNote(body, now, id = newId()) {
  return { id, status: "open", created: now, modified: now, due: null, closed: null, body };
}

/** Timestamp in the file's format: UTC, "YYYY-MM-DDTHH:MMZ". */
export function timestamp(date = new Date()) {
  return date.toISOString().slice(0, 16) + "Z";
}

/** A file timestamp in the device's local time, "YYYY-MM-DDTHH:MM", for
 *  display and day comparisons; one without "Z" (older files) is local already. */
export function localTime(ts) {
  if (!ts || !ts.endsWith("Z")) return ts;
  const d = new Date(ts);
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function parseAttrs(s) {
  const out = {};
  for (const pair of s.trim().split(/\s+/)) {
    const i = pair.indexOf("=");
    if (i > 0) out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

function decodeName(text) {
  try { return decodeURIComponent(text); } catch { return text; }
}

// A device: `name` as the device suggested it, `title` the name the user gave it, `synced` the start of its last complete sync round.
function finishDevice(meta) {
  return {
    id: meta.id, ...(meta.name && { name: decodeName(meta.name) }), ...(meta.title && { title: decodeName(meta.title) }),
    ...(meta.synced && { synced: meta.synced }),
  };
}

// A contact: `color` is a slot 1–6 (1 when missing or invalid), `server` the contact's home server (absent = the default), `pending` the time the request was sent,
// `verified` the time the user verified the contact (absent = not verified).
function finishContact(meta) {
  const color = Number(meta.color);
  return {
    id: meta.id, name: decodeName(meta.name), color: Number.isInteger(color) && color >= 1 && color <= 6 ? color : 1,
    ...(meta.server && { server: decodeName(meta.server) }),
    ...(meta.pending && { pending: meta.pending }),
    ...(meta.verified && { verified: meta.verified }),
  };
}

// A news marker: `seen` the post's `modified` the user saw last, `status` archived or deleted (absent = open).
function finishNews(meta) {
  return { id: meta.id, seen: meta.seen, ...((meta.status === "archived" || meta.status === "deleted") && { status: meta.status }) };
}

// open and closed notes are tasks; a permanent note can't be closed (docs/requirements.md → "Permanent notes").
export const STATUSES = ["open", "closed", "permanent"];

function finishNote({ meta, body }) {
  return {
    id: meta.id || newId(),
    status: STATUSES.includes(meta.status) ? meta.status : "open",
    created: meta.created || meta.modified || "",
    modified: meta.modified || meta.created || "",
    due: meta.due || null,
    closed: meta.closed || null,
    body: body.join("\n").trim(),
    ...(meta.left && { left: meta.left.split(",").filter(Boolean) }),
    ...(meta.deleted && { deleted: meta.deleted }),
    ...(meta.kept && { kept: meta.kept }),
    ...(meta.from && { from: meta.from }),
    ...(meta.copyof && { copyof: meta.copyof }),
    ...(meta.copied && { copied: meta.copied }),
    ...(meta.keep && { keep: meta.keep }),
    ...(meta.source && { source: meta.source }),
    ...(validColor(meta.color) && { color: meta.color }),
    ...(validDecor(meta.decor) && { decor: meta.decor }),
  };
}

/** A new note id; random enough to stay unique across everyone sharing a file. */
export function newId() {
  return "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

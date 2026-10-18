// Links between notes (backlog #45) and private copies of shared notes.
// A link is a plain Markdown link to `note:<id>` — `[Trip to Lisbon](note:s03)` —
// so other editors show its text; the app shows the target's current title, so
// renaming a note never breaks a link to it. A private copy carries `copyof=`
// (the original's id) and `copied=` (the original's `modified` when the copy
// took its text), so the app can say when the original changed since.
import { createNote } from "./notes-file.js";
import { noteTitle } from "./markdown.js";

const NOTE_HREF = /^note:([A-Za-z0-9_-]+)$/;

/** The note id a link's address points to, or null. */
export function noteLinkId(href) {
  const m = NOTE_HREF.exec(String(href || "").trim());
  return m ? m[1] : null;
}

/** The Markdown of a link to note `id` showing `title`. */
export function noteLink(id, title) {
  const text = String(title || "Untitled").replace(/\s+/g, " ").trim().replace(/[[\]\\]/g, "\\$&");
  return `[${text}](note:${id})`;
}

/** The `[[` the caret stands behind, with the text typed after it on the same line: { from, query } or null. */
export function linkTrigger(textBefore) {
  const m = /\[\[([^[\]\n]{0,40})$/.exec(textBefore);
  return m ? { from: textBefore.length - m[0].length, query: m[1] } : null;
}

/**
 * The notes a `[[` link in a note can point to, best match first: in a private
 * note any note the user sees, in a shared note only notes of the same circle,
 * so a link's text never tells the others about a note they can't see.
 * `notes`: [{ id, body, status, modified }], `circle(id)`: its circleKey ("" = private),
 * `from`: the edited note's id. At most `limit`.
 */
export function linkCandidates(notes, { from, circle, query = "", limit = 6 }) {
  const own = circle(from);
  const q = query.trim().toLowerCase();
  const scored = [];
  for (const n of notes) {
    if (n.id === from || n.news || n.deleted) continue;
    if (own !== "" && circle(n.id) !== own) continue;
    const title = noteTitle(n.body).text || "Untitled";
    const at = q ? title.toLowerCase().indexOf(q) : 0;
    if (at < 0) continue;
    // A title starting with the query first, then open notes, then the latest edit.
    scored.push({ id: n.id, title, closed: n.status === "closed", rank: [at === 0 ? 0 : 1, n.status === "closed" ? 1 : 0], modified: n.modified || "" });
  }
  scored.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
  return scored.slice(0, limit).map(({ id, title, closed }) => ({ id, title, closed }));
}

/** A private copy of `original` (a note of a shared file): same text, due date and look, a new id, linked back. */
export function privateCopy(original, now, id) {
  const n = createNote(original.body, now, id);
  if (original.due) n.due = original.due;
  if (original.color) n.color = original.color;
  if (original.decor) n.decor = original.decor;
  n.copyof = original.id;
  n.copied = original.modified;
  return n;
}

/**
 * How a copy stands to its original (`original` null when the user can no longer see it):
 * "gone", "changed" (edited since the copy took its text), "same" (same text) or "differs"
 * (only the copy was edited).
 */
export function copyState(copy, original) {
  if (!original) return "gone";
  if (original.modified !== copy.copied) return "changed";
  return original.body === copy.body ? "same" : "differs";
}

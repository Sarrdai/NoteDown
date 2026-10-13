// The NoteDown file: one Markdown file holding every note, open and closed.
// Each note starts with a marker comment that carries its metadata and runs
// until the next marker (docs/file-format.md):
//
//   <!-- note id=n1 status=open created=2026-10-01T09:12 modified=2026-10-12T18:03 due=2026-10-15 -->
//   ## Shopping
//   - [ ] Milk
//
// Text before the first marker is kept as the file's preamble. A note that
// was moved to another file (sharing) leaves a bodyless marker with `moved=`.

const MARKER = /^<!-- note ((?:[a-z]+=\S+ ?)*)-->$/;

/** Parses a NoteDown file into { preamble, notes, moved }. */
export function parseNotesFile(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const notes = [];
  const moved = [];
  const finish = c => c.meta.moved && c.meta.id
    ? moved.push({ id: c.meta.id, moved: c.meta.moved })
    : notes.push(finishNote(c));
  const preamble = [];
  let current = null;
  for (const line of lines) {
    const m = MARKER.exec(line.trim());
    if (m) {
      if (current) finish(current);
      current = { meta: parseAttrs(m[1]), body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) finish(current);
  return { preamble: preamble.join("\n").trim(), notes, moved };
}

/** Writes { preamble, notes, moved } back into the file format. */
export function serializeNotesFile({ preamble = "", notes, moved = [] }) {
  const parts = preamble ? [preamble] : [];
  for (const n of notes) {
    const attrs = ["id=" + n.id, "status=" + n.status, "created=" + n.created, "modified=" + n.modified];
    if (n.due) attrs.push("due=" + n.due);
    if (n.closed) attrs.push("closed=" + n.closed);
    parts.push(`<!-- note ${attrs.join(" ")} -->\n${n.body.trim()}`);
  }
  for (const m of moved) parts.push(`<!-- note id=${m.id} moved=${m.moved} -->`);
  return parts.join("\n\n") + "\n";
}

/** A new open note; `now` is a local timestamp "YYYY-MM-DDTHH:MM". */
export function createNote(body, now, id = newId()) {
  return { id, status: "open", created: now, modified: now, due: null, closed: null, body };
}

/** Local timestamp in the file's format. */
export function timestamp(date = new Date()) {
  const p = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}

function parseAttrs(s) {
  const out = {};
  for (const pair of s.trim().split(/\s+/)) {
    const i = pair.indexOf("=");
    if (i > 0) out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

function finishNote({ meta, body }) {
  return {
    id: meta.id || newId(),
    status: meta.status === "closed" ? "closed" : "open",
    created: meta.created || meta.modified || "",
    modified: meta.modified || meta.created || "",
    due: meta.due || null,
    closed: meta.closed || null,
    body: body.join("\n").trim(),
  };
}

/** A new note id; random enough to stay unique across everyone sharing a file. */
export function newId() {
  return "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

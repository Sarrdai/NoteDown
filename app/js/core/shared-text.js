// Text shared into NoteDown from another app (Android share sheet, docs/requirements.md → "Quick capture"):
// the body of the new note. A subject (a web page's title, an e-mail's subject) becomes the note's heading,
// the text its body; without a subject the note has no heading, like a dictated one.

/** The new note's body for a shared `text` and optional `subject`; "" when nothing usable was shared. */
export function sharedNoteBody({ text = "", subject = "" } = {}) {
  const body = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  const title = String(subject ?? "").replace(/\s+/g, " ").trim();
  // Some apps repeat the subject as the text's first line: it isn't written twice.
  if (!title || body.split("\n", 1)[0].trim() === title) return body;
  return body ? `## ${title}\n\n${body}` : `## ${title}`;
}

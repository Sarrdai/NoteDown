// Labels: #hashtags in a note's text (like Obsidian), so they stay plain
// Markdown. A label follows a space or the line start ("# Heading" with a
// space stays a heading, "issue#5" is no label), runs over letters, digits,
// "_", "-" and "/" and holds at least one letter or "_" ("#5" is no label).
// Compared case-insensitively; a label is shown in the spelling it first
// appears in.

/** A label at the start of a string: [whole match, name]. */
export const LABEL_AT = /^#(?=[\p{N}/-]*[\p{L}_])([\p{L}\p{N}_](?:[\p{L}\p{N}_/-]*[\p{L}\p{N}_])?)/u;
const LABEL_IN = /(^|[\s(])#(?=[\p{N}/-]*[\p{L}_])([\p{L}\p{N}_](?:[\p{L}\p{N}_/-]*[\p{L}\p{N}_])?)/gu;

export const labelKey = name => name.toLocaleLowerCase();

// Code (fenced and inline) and link targets carry no labels.
function prose(body) {
  return body
    .replace(/^\s*(```|~~~)[\s\S]*?(^\s*\1|(?![\s\S]))/gm, "")
    .replace(/`[^`\n]*`/g, "")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/\b(https?:\/\/|www\.)\S+/g, "");
}

/** The labels of a body in order of appearance, each once. */
export function labelsOf(body) {
  const seen = new Map();
  for (const m of prose(body).matchAll(LABEL_IN)) if (!seen.has(labelKey(m[2]))) seen.set(labelKey(m[2]), m[2]);
  return [...seen.values()];
}

export const hasLabel = (body, name) => labelsOf(body).some(l => labelKey(l) === labelKey(name));

/** Every label of the notes with how many notes carry it, A–Z: [{ name, count }]. */
export function labelCounts(notes) {
  const all = new Map();
  for (const n of notes) for (const l of labelsOf(n.body)) {
    const e = all.get(labelKey(l)) || all.set(labelKey(l), { name: l, count: 0 }).get(labelKey(l));
    e.count++;
  }
  return [...all.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** A label name from another app (e.g. Google Keep's "Trip ideas") as a
 *  NoteDown label: spaces become "-", characters a label can't hold go. */
export function toLabel(name) {
  const s = name.trim().replace(/[^\p{L}\p{N}_/\s-]/gu, "").trim().replace(/\s+/g, "-").replace(/^[-/]+|[-/]+$/g, "");
  return /[\p{L}_]/u.test(s) ? s : null;
}

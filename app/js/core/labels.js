// Labels: #hashtags in a note's text (like Obsidian), so they stay plain
// Markdown. A label follows a space or the line start ("# Heading" with a
// space stays a heading, "issue#5" is no label), runs over letters, digits,
// emoji, "_", "-" and "/" and holds at least one letter, emoji or "_" ("#5"
// is no label, "#😉" is one). Compared case-insensitively; a label is shown
// in the spelling it first appears in.

// An emoji: a pictograph or flag letter, with what joins and varies it
// (variation selector, zero-width joiner, skin tone, keycap).
const EMOJI = String.raw`\p{Extended_Pictographic}\p{Regional_Indicator}`;
const JOIN = String.raw`\u{FE0F}\u{200D}\p{Emoji_Modifier}\u{20E3}`;
const START = String.raw`[\p{L}\p{N}_${EMOJI}]`;
const INNER = String.raw`[\p{L}\p{N}_/${EMOJI}${JOIN}-]`;
const END = String.raw`[\p{L}\p{N}_${EMOJI}${JOIN}]`;
const NAME = String.raw`(?=[\p{N}/-]*[\p{L}_${EMOJI}])(${START}(?:${INNER}*${END})?)`;

/** A label at the start of a string: [whole match, name]. */
export const LABEL_AT = new RegExp("^#" + NAME, "u");
const LABEL_IN = new RegExp(String.raw`(^|[\s(])#` + NAME, "gu");
/** Where a label may start: [match, the character before "#"]. */
export const LABEL_START = new RegExp(String.raw`(^|[\s(])#${START}`, "u");

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
  const s = name.trim().replace(new RegExp(String.raw`[^\p{L}\p{N}_/\s${EMOJI}${JOIN}-]`, "gu"), "").trim().replace(/\s+/g, "-").replace(/^[-/]+|[-/]+$/g, "");
  return new RegExp(String.raw`[\p{L}_${EMOJI}]`, "u").test(s) ? s : null;
}

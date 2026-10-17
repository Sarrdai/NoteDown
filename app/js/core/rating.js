// Star ratings in a note's body (backlog #42): a run of 3 to 10 stars, the
// filled ones first ("★★★☆☆"). Plain text in the Markdown; the view draws
// tappable stars, a tap on the n-th star makes the rating n (a tap on the
// highest filled star clears it). The length of the run never changes.

const FULL = "★", EMPTY = "☆";
const MIN = 3, MAX = 10;
const RUN = /[★☆]+/gu;
const SHAPE = /^★*☆*$/u;

function parse(raw) {
  if (raw.length < MIN || raw.length > MAX || !SHAPE.test(raw)) return null;
  return { raw, value: raw.indexOf(EMPTY) < 0 ? raw.length : raw.indexOf(EMPTY), size: raw.length };
}

/** The rating right at the start of `src`, or null (the Markdown renderer's tokenizer). */
export function ratingAt(src) {
  const m = /^[★☆]+/u.exec(src);
  return m ? parse(m[0]) : null;
}

/** Where the next rating in `src` starts, or -1. */
export function ratingStart(src) {
  for (const m of src.matchAll(RUN)) if (parse(m[0])) return m.index;
  return -1;
}

/** The ratings of a body in document order, outside code: [{ raw, value, size, from, to }]. */
export function ratings(body) {
  const out = [];
  let fence = null;
  let offset = 0;
  for (const line of body.split("\n")) {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) fence = fence === null ? f[1] : fence === f[1] ? null : fence;
    else if (fence === null) {
      const text = line.replace(/(`+)[^`]*?\1/g, s => " ".repeat(s.length));
      for (const m of text.matchAll(RUN)) {
        const r = parse(m[0]);
        if (r) out.push({ ...r, from: offset + m.index, to: offset + m.index + m[0].length });
      }
    }
    offset += line.length + 1;
  }
  return out;
}

/** The body with the n-th rating (0-based, document order) set to `n` stars; the current value clears it. */
export function setRating(body, index, n) {
  const r = ratings(body)[index];
  if (!r || n < 1 || n > r.size) return body;
  const v = n === r.value ? 0 : n;
  return body.slice(0, r.from) + FULL.repeat(v) + EMPTY.repeat(r.size - v) + body.slice(r.to);
}

/** What the toolbar inserts at a caret preceded by `before`: an empty rating, with a space when glued to text. */
export function newRating(before) {
  return (before && !/\s$/.test(before) ? " " : "") + EMPTY.repeat(5);
}

/** The markup for a rating, shared by the rendered note and the editor's widget. */
export function ratingHtml(r) {
  const stars = Array.from({ length: r.size }, (_, i) =>
    `<button type="button" class="star${i < r.value ? " on" : ""}" data-star="${i + 1}" aria-label="${i + 1} of ${r.size} stars"><span aria-hidden="true">${i < r.value ? FULL : EMPTY}</span></button>`).join("");
  return `<span class="rating" role="group" data-value="${r.value}" data-size="${r.size}" aria-label="Rating ${r.value} of ${r.size}">${stars}</span>`;
}

// Suggestions in the search field (backlog #66): the filters (∞ Permanent,
// labels, circles) and the headings that match what is typed, found
// fuzzily — the typed letters in order, gaps allowed ("trvl" finds
// #travel, "gp" Garden plan), ignoring case and accents. Without text the field offers the
// filters; "#" offers only the labels.

// A string as single folded characters (lower case, no accents), each with its index in the original.
function folded(text) {
  const chars = [];
  let i = 0;
  for (const cp of text) {
    const f = cp.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
    chars.push({ c: f.length === 1 ? f : cp.toLocaleLowerCase(), i, n: cp.length });
    i += cp.length;
  }
  return chars;
}

const isWordStart = (chars, k) => k === 0 || !/[\p{L}\p{N}]/u.test(chars[k - 1].c);

/** How well `query` matches `text`, or null: { score, ranges } with the
 *  matched [start, end) pairs of `text`. A run of the whole query beats
 *  scattered letters, at the start beats at a word's start beats inside
 *  a word; shorter texts win ties. Whitespace in the query is ignored. */
export function fuzzyMatch(query, text) {
  const q = folded(query.replace(/\s+/g, "")).map(x => x.c);
  if (!q.length) return { score: 0, ranges: [] };
  const t = folded(text);
  const range = (from, to) => [t[from].i, t[to].i + t[to].n];
  const s = t.map(x => x.c).join("");
  // One run: the earliest at a word start, else the first anywhere — a single letter only at a word start.
  if (s.length === t.length) {
    const word = q.join("");
    let at = -1;
    for (let k = s.indexOf(word); k >= 0; k = s.indexOf(word, k + 1)) if (isWordStart(t, k)) { at = k; break; }
    const pos = at >= 0 ? at : s.indexOf(word);
    if (pos >= 0 && (at >= 0 || q.length > 1)) return { score: (pos === 0 ? 3000 : at >= 0 ? 2000 : 1000) - t.length, ranges: [range(pos, pos + q.length - 1)] };
  }
  // Scattered: each letter at the next word start that has it, else (when that
  // leaves no room for the rest) at the next place it occurs.
  const place = preferStarts => {
    const hits = [];
    for (const c of q) {
      const from = hits.length ? hits.at(-1) + 1 : 0;
      let found = preferStarts ? t.findIndex((x, j) => j >= from && x.c === c && isWordStart(t, j)) : -1;
      if (found < 0) found = t.findIndex((x, j) => j >= from && x.c === c);
      if (found < 0) return null;
      hits.push(found);
    }
    return hits;
  };
  const hits = place(true) || place(false);
  if (!hits) return null;
  let score = 0;
  const ranges = [];
  hits.forEach((h, n) => {
    if (isWordStart(t, h)) score += 10;
    if (n && hits[n - 1] === h - 1) { score += 5; ranges.at(-1)[1] = range(h, h)[1]; }
    else ranges.push(range(h, h));
  });
  // Few loose letters spread over a text match nearly anything: scattered letters count only as
  // initials (each piece starts a word) or, from three letters on, with at least two of them together.
  const initials = ranges.every(([a]) => isWordStart(t, t.findIndex(x => x.i === a)));
  if (!initials && (q.length < 3 || ranges.length >= q.length)) return null;
  score -= hits.at(-1) - hits[0] + 1 - hits.length;   // the letters skipped between the first and last hit
  return { score: Math.min(score, 999) - t.length / 100, ranges };
}

const KIND_ORDER = { permanent: 0, label: 1, circle: 2, heading: 3 };

/**
 * The suggestions for `query`, best first: [{ kind, text, value, count, ranges }]
 * with `kind` "permanent" | "label" | "circle" | "heading" and `value` what a
 * pick sets (a label's name, a circle's key, a heading's text).
 * `permanent` is the number of permanent notes (0/null: not offered), `labels`
 * [{ name, count }], `circles` [{ key, name, count }], `headings` [text] — only
 * what can still be picked. Without text: every filter, no headings.
 */
export function suggestions(query, { permanent = 0, labels = [], circles = [], headings = [] }, limit = 8) {
  const q = query.trim();
  const onlyLabels = q.startsWith("#");
  const rest = onlyLabels ? q.slice(1) : q;
  const all = [
    ...(permanent && !onlyLabels ? [{ kind: "permanent", text: "Permanent", value: true, count: permanent }] : []),
    ...labels.map(l => ({ kind: "label", text: "#" + l.name, value: l.name, count: l.count, match: l.name, offset: 1 })),
    ...(onlyLabels ? [] : circles.map(c => ({ kind: "circle", text: c.name, value: c.key, count: c.count }))),
  ];
  if (!rest) return all.map(({ match, offset, ...s }) => ({ ...s, ranges: [] }));
  const seen = new Set();
  const heads = onlyLabels ? [] : headings.filter(h => {
    const key = h.toLocaleLowerCase();
    if (seen.has(key) || key === q.toLocaleLowerCase()) return false;
    seen.add(key);
    return true;
  }).map(h => ({ kind: "heading", text: h, value: h, count: null }));
  return [...all, ...heads]
    .map(({ match, offset = 0, ...s }) => {
      const m = fuzzyMatch(rest, match ?? s.text);
      return m && { ...s, score: m.score, ranges: m.ranges.map(([a, b]) => [a + offset, b + offset]) };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
    .slice(0, limit)
    .map(({ score, ...s }) => s);
}

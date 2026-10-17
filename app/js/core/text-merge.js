// Three-way merge of a note's text (docs/sync-and-sharing.md → "Merging", backlog #47): when two devices changed
// the same note's text, the changes are combined line by line (diff3) and a conflict copy is only needed when
// both changed the same line in ways that don't combine. Counters add both sides' steps, and a task's box and
// its text merge apart, so ticking, counting and timing on a shared note rarely clash.
import { TASK_LINE } from "./markdown.js";
import { counters, addChanges } from "./counter.js";

// Above this many cells for the line comparison the merge gives up (a conflict copy as before), so a huge
// note can't stall a sync round.
const MAX_CELLS = 4_000_000;

/**
 * `base` changed to `local` on one side and to `remote` on the other → the merged text, or null when the
 * changes overlap and don't combine. `localNewer`: the local side was modified later; it decides what can't be
 * combined within a line (a task box both changed, a stopwatch both stopped).
 */
export function mergeText(base, local, remote, localNewer) {
  if (local === base || local === remote) return remote;
  if (remote === base) return local;
  const [b, l, r] = [base, local, remote].map(t => t.split("\n"));
  const hl = hunks(b, l), hr = hunks(b, r);
  if (!hl || !hr) return null;
  const all = [...hl.map(h => ({ ...h, side: "l" })), ...hr.map(h => ({ ...h, side: "r" }))]
    .sort((x, y) => x.s - y.s || (x.e - x.s) - (y.e - y.s));
  const out = [];
  let at = 0;
  for (let i = 0; i < all.length;) {
    // A group: hunks of both sides that touch the same base lines, or insert at the same place.
    const group = [all[i]];
    let gs = all[i].s, ge = all[i].e;
    for (i++; i < all.length; i++) {
      const h = all[i];
      const insertsHere = h.s === h.e && h.s === ge && group.every(g => g.s === g.e);
      if (h.s < ge || insertsHere) { group.push(h); ge = Math.max(ge, h.e); } else break;
    }
    out.push(...b.slice(at, gs));
    const lines = resolve(b, gs, ge, group, localNewer);
    if (!lines) return null;
    out.push(...lines);
    at = ge;
  }
  out.push(...b.slice(at));
  return out.join("\n");
}

// The lines that replace base[gs, ge) for one group of hunks, or null.
function resolve(b, gs, ge, group, localNewer) {
  const version = side => {
    const own = group.filter(h => h.side === side);
    if (!own.length) return null;
    const lines = [];
    let at = gs;
    for (const h of own) { lines.push(...b.slice(at, h.s), ...h.lines); at = h.e; }
    return [...lines, ...b.slice(at, ge)];
  };
  const l = version("l"), r = version("r");
  if (!l || !r) return l || r;
  if (l.join("\n") === r.join("\n")) return l;
  // Both added lines at the same place: keep both, the remote ones first.
  if (gs === ge) return [...r, ...l];
  if (l.length !== ge - gs || r.length !== ge - gs) return null;
  const out = [];
  for (let k = 0; k < l.length; k++) {
    const line = mergeLine(b[gs + k], l[k], r[k], localNewer);
    if (line === null) return null;
    out.push(line);
  }
  return out;
}

/** One line both sides changed → the combined line, or null: a task's box and text merge apart, counters add up. */
export function mergeLine(b, l, r, localNewer) {
  if (l === b || l === r) return r;
  if (r === b) return l;
  const [tb, tl, tr] = [b, l, r].map(x => TASK_LINE.exec(x));
  if (tb && tl && tr) {
    const head = m => m[1] + m[2] + m[3];
    const rest = mergeLine(b.slice(head(tb).length), l.slice(head(tl).length), r.slice(head(tr).length), localNewer);
    if (rest === null) return null;
    const box = tl[2] === tb[2] ? tr[2] : tr[2] === tb[2] ? tl[2] : localNewer ? tl[2] : tr[2];
    return (tl[1] === tb[1] ? tr[1] : tl[1]) + box + "]" + rest;
  }
  return mergeCounters(b, l, r, localNewer);
}

// A line whose counters changed: the text around them merges as a whole, each counter on its own.
function mergeCounters(b, l, r, localNewer) {
  const [cb, cl, cr] = [b, l, r].map(counters);
  if (!cb.length || cb.length !== cl.length || cb.length !== cr.length) return null;
  const frame = (line, cs) => {
    const parts = [];
    let at = 0;
    for (const c of cs) { parts.push(line.slice(at, c.from)); at = c.to; }
    return [...parts, line.slice(at)].join("\u0000");
  };
  const [fb, fl, fr] = [frame(b, cb), frame(l, cl), frame(r, cr)];
  const text = fl === fb ? fr : fr === fb || fl === fr ? fl : null;
  if (text === null) return null;
  const merged = [];
  for (let k = 0; k < cb.length; k++) {
    const c = mergeCounter(cb[k], cl[k], cr[k], localNewer);
    if (c === null) return null;
    merged.push(c);
  }
  return text.split("\u0000").reduce((s, part, k) => s + part + (merged[k] ?? ""), "");
}

// One counter: the shape (unit, steps, stopwatch rounding) from the side that changed it, the value with both
// sides' steps added; a stopwatch both started runs from the earlier start, one both stopped (or otherwise both
// changed) takes the newer side's counter, so a run isn't counted twice.
function mergeCounter(b, l, r, localNewer) {
  if (l.raw === b.raw || l.raw === r.raw) return r.raw;
  if (r.raw === b.raw) return l.raw;
  if (l.kind !== b.kind || r.kind !== b.kind) return null;
  const shape = c => [c.unit, c.steps.join(" "), c.watch ? c.watch.round : "-"].join("|");
  const [sb, sl, sr] = [shape(b), shape(l), shape(r)];
  if (sl !== sb && sr !== sb && sl !== sr) return null;
  const form = sl !== sb ? l : r;   // the side whose shape wins; its raw text is rewritten below
  const since = c => (c.watch ? c.watch.since : null);
  const [wb, wl, wr] = [since(b), since(l), since(r)];
  let start;
  if (wl === wb) start = wr;
  else if (wr === wb) start = wl;
  else if (!wb && wl && wr) start = wl < wr ? wl : wr;
  else return (localNewer ? l : r).raw;
  const value = addChanges(b.value, l.value, r.value);
  const wasRunning = since(form);
  let raw = form.raw.replace(form.value, value);
  if (wasRunning && !start) raw = raw.replace(new RegExp(String.raw`[ \t]+` + wasRunning), "");
  else if (wasRunning && start) raw = raw.replace(wasRunning, start);
  else if (!wasRunning && start) raw = raw.replace(/⏱\d*/, m => m + " " + start);
  return raw;
}

// The changes from base to side as hunks { s, e (base line range replaced), lines (what replaces it) },
// in order and never touching each other; null when the notes are too big to compare.
function hunks(base, side) {
  let pre = 0;
  while (pre < base.length && pre < side.length && base[pre] === side[pre]) pre++;
  let suf = 0;
  while (suf < base.length - pre && suf < side.length - pre && base[base.length - 1 - suf] === side[side.length - 1 - suf]) suf++;
  const a = base.slice(pre, base.length - suf), c = side.slice(pre, side.length - suf);
  const n = a.length, m = c.length;
  if (!n && !m) return [];
  if ((n + 1) * (m + 1) > MAX_CELLS) return null;
  // Longest common subsequence, from the back, so the walk below goes forward.
  const w = m + 1, len = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      len[i * w + j] = a[i] === c[j] ? len[(i + 1) * w + j + 1] + 1 : Math.max(len[(i + 1) * w + j], len[i * w + j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0, hs = -1, hj = 0;
  const close = () => { if (hs >= 0) { out.push({ s: pre + hs, e: pre + i, lines: c.slice(hj, j) }); hs = -1; } };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === c[j]) { close(); i++; j++; continue; }
    if (hs < 0) { hs = i; hj = j; }
    if (j < m && (i === n || len[i * w + j + 1] >= len[(i + 1) * w + j])) j++;
    else i++;
  }
  close();
  return out;
}

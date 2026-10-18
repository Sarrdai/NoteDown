// A line diff of two texts, for comparing a private copy with its original:
// which lines only the copy has, which only the original, and which both.

/** The lines of `a` → `b` as [{ type: "same" | "del" | "add", text }] (longest common subsequence;
 *  a run of changed lines lists the deleted lines before the added ones). */
export function lineDiff(a, b) {
  const x = a.split("\n"), y = b.split("\n");
  // Common head and tail first: notes differ in a few places, and the table stays small.
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head++;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  const xs = x.slice(head, x.length - tail), ys = y.slice(head, y.length - tail);
  const n = xs.length, m = ys.length;
  const len = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    len[i][j] = xs[i] === ys[j] ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1]);
  }
  const mid = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && xs[i] === ys[j]) { mid.push({ type: "same", text: xs[i] }); i++; j++; }
    else if (j >= m || (i < n && len[i + 1][j] >= len[i][j + 1])) mid.push({ type: "del", text: xs[i++] });
    else mid.push({ type: "add", text: ys[j++] });
  }
  const same = text => ({ type: "same", text });
  return [...x.slice(0, head).map(same), ...ordered(mid), ...x.slice(x.length - tail).map(same)];
}

// Within each run of changes, the deleted lines come before the added ones.
function ordered(ops) {
  const out = [];
  for (let k = 0; k < ops.length;) {
    if (ops[k].type === "same") { out.push(ops[k++]); continue; }
    const run = [];
    while (k < ops.length && ops[k].type !== "same") run.push(ops[k++]);
    out.push(...run.filter(o => o.type === "del"), ...run.filter(o => o.type === "add"));
  }
  return out;
}

/** Counts of a diff: { del, add }. */
export function diffCounts(ops) {
  return { del: ops.filter(o => o.type === "del").length, add: ops.filter(o => o.type === "add").length };
}

/** Folds runs of unchanged lines longer than 2 × `context` + 1 into { type: "fold", count }, keeping `context` lines around each change. */
export function foldSame(ops, context = 2) {
  const out = [];
  for (let k = 0; k < ops.length;) {
    if (ops[k].type !== "same") { out.push(ops[k++]); continue; }
    let end = k;
    while (end < ops.length && ops[end].type === "same") end++;
    const keepHead = k === 0 ? 0 : context, keepTail = end === ops.length ? 0 : context;
    if (end - k > keepHead + keepTail + 1) {
      out.push(...ops.slice(k, k + keepHead), { type: "fold", count: end - k - keepHead - keepTail }, ...ops.slice(end - keepTail, end));
    } else out.push(...ops.slice(k, end));
    k = end;
  }
  return out;
}


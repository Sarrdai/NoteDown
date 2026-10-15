// Clearing done tasks (docs/requirements.md → "Clear done tasks"): the
// ticked task items of a note, or of selected sections of it, leave the note
// and become a closed note of their own in the archive; "Back to note" puts
// them back into the note they came from.
import { sections, noteTitle } from "./markdown.js";

const TASK = /^(\s*)(?:[-*+]|\d+[.)])\s+\[([ xX])\]/;
const FENCE = /^\s*(```|~~~)/;
const indent = line => /^\s*/.exec(line)[0].length;

// Line numbers of the ticked tasks within [a, b) and the lines below them that
// belong to them (deeper indented, up to a blank line), outside code fences.
function doneLines(lines, a, b) {
  const out = new Set();
  let fence = null;
  for (let i = a; i < b; i++) {
    const f = FENCE.exec(lines[i]);
    if (f) { fence = fence === null ? f[1] : fence === f[1] ? null : fence; continue; }
    if (fence !== null) continue;
    const m = TASK.exec(lines[i]);
    if (!m || m[2] === " ") continue;
    out.add(i);
    let j = i + 1;
    for (; j < b && lines[j].trim() && indent(lines[j]) > m[1].length; j++) out.add(j);
    i = j - 1;
  }
  return out;
}

// The body lines the parts cover ({ whole } or sections `from`–`to`, core/selection.js).
function ranges(body, parts) {
  const ss = sections(body);
  return parts.map(p => (p.whole ? [0, body.split("\n").length] : [ss[p.from].start, ss[p.to - 1].end]));
}

/** How many ticked tasks the parts of a note hold. */
export function countDone(body, parts) {
  const lines = body.split("\n");
  return ranges(body, parts).reduce((sum, [a, b]) => sum + [...doneLines(lines, a, b)].filter(i => TASK.test(lines[i])).length, 0);
}

/**
 * Takes the ticked tasks out of the parts of a note. → { body (the rest; null
 * when nothing is left), done (the archived note's body), count }. The archived
 * body starts with the note's title heading and keeps each task under the
 * heading of the section it came from, so it can go back there.
 */
export function clearDone(body, parts) {
  const lines = body.split("\n");
  const drop = new Set(ranges(body, parts).flatMap(([a, b]) => [...doneLines(lines, a, b)]));
  if (!drop.size) return { body, done: "", count: 0 };
  const ss = sections(body);
  const title = noteTitle(body).fromHeading ? ss.find(s => s.depth !== null) : null;
  const groups = [];
  for (const s of ss) {
    const items = lines.slice(s.start, s.end).filter((_, k) => drop.has(s.start + k));
    if (!items.length) continue;
    const head = s.depth !== null ? lines[s.start] : null;
    groups.push([head, items]);
  }
  if (title && groups[0][0] !== lines[title.start]) groups.unshift([lines[title.start], []]);
  const done = groups.map(([head, items]) => [head, ...items].filter(l => l !== null).join("\n")).join("\n\n");
  const rest = lines.filter((_, i) => !drop.has(i)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const count = [...drop].filter(i => TASK.test(lines[i])).length;
  return { body: rest || null, done, count };
}

/**
 * Back to note: puts the tasks of an archived body (clearDone → done) back
 * into `body`, each group at the end of the section with the same heading,
 * else at the end of the note; the order inside the note isn't restored.
 */
export function returnDone(body, done) {
  const lines = body.split("\n");
  const at = new Map();   // insert position → lines to insert
  const tail = [];
  for (const s of sections(done)) {
    const own = done.split("\n").slice(s.start, s.end);
    const items = (s.depth !== null ? own.slice(1) : own).filter(l => l.trim());
    if (!items.length) continue;
    const head = s.depth !== null ? own[0].trim() : null;
    const target = head && sections(body).find(t => t.depth !== null && lines[t.start].trim() === head);
    if (!target) { tail.push(...items); continue; }
    let end = target.end;
    while (end > target.start + 1 && !lines[end - 1].trim()) end--;
    at.set(end, [...(at.get(end) || []), ...items]);
  }
  const out = [];
  lines.forEach((line, i) => { out.push(...(at.get(i) || []), line); });
  out.push(...(at.get(lines.length) || []));
  const joined = out.join("\n").trimEnd();
  return tail.length ? (joined ? joined + "\n" + tail.join("\n") : tail.join("\n")) : joined;
}

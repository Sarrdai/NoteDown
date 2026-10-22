// List items (bullets, numbered items, tasks) as selectable and movable parts
// (docs/requirements.md → "Multi-select"): where each item starts and ends in
// the source, its siblings, and moving items up or down among them.

const ITEM = /^(\s*)(?:[-*+]|\d+[.)])(?:[ \t]+|$)/;
const RULE = /^\s*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const FENCE = /^\s*(```|~~~)/;

/** An item's key in the selection: the note and the item's first line. */
export const itemKey = (noteId, line) => `${noteId}@${line}`;

/** The note and line of an item key, or null for another key. */
export function parseItemKey(key) {
  const at = key.lastIndexOf("@");
  const line = Number(key.slice(at + 1));
  return at > 0 && /^\d+$/.test(key.slice(at + 1)) ? { noteId: key.slice(0, at), line } : null;
}

/**
 * The list items of a body in document order (as the rendered <li>s),
 * outside code fences: [{ line, end, indent }] — `end` exclusive, after the
 * item's last non-blank line, its indented lines and sub-items included.
 */
export function listItems(body) {
  const lines = body.split("\n");
  const indent = s => /^\s*/.exec(s)[0].replace(/\t/g, "    ").length;
  const out = [];
  let fence = null;
  lines.forEach((text, line) => {
    const f = FENCE.exec(text);
    if (f) { fence = fence === null ? f[1] : fence === f[1] ? null : fence; return; }
    if (fence !== null || RULE.test(text)) return;
    const m = ITEM.exec(text);
    if (m) out.push({ line, indent: indent(text) });
  });
  for (const it of out) {
    let end = it.line + 1;
    for (let j = it.line + 1; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      if (indent(lines[j]) <= it.indent) break;
      end = j + 1;
    }
    it.end = end;
  }
  return out;
}

// The item before / after `it` in the same list: same indent, only blank lines between them.
function sibling(items, lines, it, dir) {
  const i = items.findIndex(x => x.line === it.line);
  if (dir < 0) {
    for (let k = i - 1; k >= 0; k--) {
      const p = items[k];
      if (p.indent < it.indent) return null;
      if (p.indent === it.indent) return p.end <= it.line && lines.slice(p.end, it.line).every(l => !l.trim()) ? p : null;
    }
    return null;
  }
  const n = items.find(x => x.line >= it.end);
  return n && n.indent === it.indent && lines.slice(it.end, n.line).every(l => !l.trim()) ? n : null;
}

/** The selected items as blocks of consecutive siblings: [[item, …], …] in document order. Items inside a
 *  selected item are part of it and don't count. */
export function itemBlocks(body, lines) {
  const items = listItems(body);
  const src = body.split("\n");
  const chosen = items.filter(it => lines.includes(it.line))
    .filter((it, _, all) => !all.some(o => o !== it && o.line < it.line && o.end >= it.end));
  const blocks = [];
  for (const it of chosen) {
    const last = blocks[blocks.length - 1]?.at(-1);
    if (last && sibling(items, src, last, 1) === it) blocks[blocks.length - 1].push(it);
    else blocks.push([it]);
  }
  return blocks;
}

/**
 * Moves the selected items (first lines `lines`) one place up (delta −1) or
 * down (+1) among their siblings, as one block: possible when they are
 * consecutive siblings and a sibling lies that way. Returns { body, shift }
 * (`shift`: how many lines the items moved) or null.
 */
export function moveItems(body, lines, delta) {
  const blocks = itemBlocks(body, lines);
  if (blocks.length !== 1) return null;
  const block = blocks[0];
  const items = listItems(body);
  const src = body.split("\n");
  const first = block[0], last = block[block.length - 1];
  const other = sibling(items, src, delta < 0 ? first : last, delta);
  if (!other) return null;
  const [a, b] = delta < 0 ? [other, { line: first.line, end: last.end }] : [{ line: first.line, end: last.end }, other];
  // a, gap, b → b, gap, a
  const out = [...src.slice(0, a.line), ...src.slice(b.line, b.end), ...src.slice(a.end, b.line), ...src.slice(a.line, a.end), ...src.slice(b.end)];
  const shift = delta < 0 ? a.line - b.line : (b.end - b.line) + (b.line - a.end);
  return { body: out.join("\n"), shift };
}

/** Whether moveItems would move the items that way. */
export const canMoveItems = (body, lines, delta) => moveItems(body, lines, delta) !== null;

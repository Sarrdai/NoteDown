// Move to…: selected parts (whole notes or sections) go into a section of
// another note (docs/requirements.md → "Multi-select" → "Move to"). They land at
// the end of the section's own text, before its subsections and before the
// label lines that close it; plain text becomes tasks when that section ends
// with a task list (switchable). Parts with headings become subsections of
// the target section.
import { sections, TASK_LINE } from "./markdown.js";
import { LABEL_AT } from "./labels.js";
import { partText, withoutParts, copyText } from "./selection.js";

const ATX = /^( {0,3})(#{1,6})(?=\s|$)/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+/;

// A line of labels only ("#shopping #home"): it closes its section and stays last.
const labelsOnly = line => {
  const words = line.trim().split(/\s+/);
  return words[0] !== "" && words.every(w => LABEL_AT.test(w) && LABEL_AT.exec(w)[0] === w);
};

/** The target's body without its own moving parts (a section of the target can move inside it). */
export function targetRest(body, ownParts) {
  return ownParts.length ? withoutParts(body, ownParts) || "" : body;
}

// Where a section's own text ends: after its last line that is neither blank nor labels.
function endOf(lines, s) {
  let at = s.end;
  while (at > s.start + (s.depth ? 1 : 0) && (!lines[at - 1].trim() || labelsOnly(lines[at - 1]))) at--;
  return at;
}

// Whether the section's own text ends with a task item (or a line indented below one).
function endsWithTasks(lines, s) {
  for (let i = endOf(lines, s) - 1; i >= s.start; i--) {
    if (/^\s/.test(lines[i]) && lines[i].trim()) continue;
    return TASK_LINE.test(lines[i]);
  }
  return false;
}

/** The target's sections as picker rows: [{ index, text, depth, fromHeading, tasks }]
 *  (`tasks`: the section ends with a task list, so plain text becomes tasks by default). */
export function moveOutline(body) {
  const lines = body.split("\n");
  return sections(body).map((s, index) => ({ index, text: s.text, depth: s.depth, fromHeading: s.depth !== null, tasks: endsWithTasks(lines, s) }));
}

/** Plain text as task items: list items get a box, every paragraph becomes one task. */
export function asTasks(text) {
  return text.split(/\n\s*\n/).map(block => {
    const lines = block.split("\n").filter(l => l.trim());
    if (lines.every(l => LIST_ITEM.test(l) || /^\s/.test(l))) {
      return lines.map(l => TASK_LINE.test(l) || /^\s/.test(l) ? l : l.replace(LIST_ITEM, "- [ ] ")).join("\n");
    }
    return "- [ ] " + lines.map(l => l.trim()).join(" ");
  }).join("\n");
}

const hasHeading = text => text.split("\n").some(l => ATX.test(l));

// Moves a part so its highest heading is on `level`; deeper headings stop at 6.
function alignTo(text, level) {
  const lines = text.split("\n");
  const at = lines.map((l, i) => (ATX.test(l) ? i : -1)).filter(i => i >= 0);
  const delta = level - Math.min(...at.map(i => ATX.exec(lines[i])[2].length));
  for (const i of at) lines[i] = lines[i].replace(ATX, (_, sp, h) => sp + "#".repeat(Math.min(6, Math.max(1, h.length + delta))));
  return lines.join("\n");
}

/**
 * Moves `parts` (in their order; plain ones first, so none ends up under a
 * moved heading) into section `index` of `targetId`'s body without its own
 * moving parts. `asTask`: plain text becomes task items, joined to the list
 * the section ends with. Returns the target's new body and each other
 * source's remaining body (null = the note goes): { body, changes }.
 * `notes`: the target and the sources by id.
 */
export function moveInto(notes, parts, targetId, index, { asTask = false } = {}) {
  const rest = targetRest(notes[targetId].body, parts.filter(p => p.noteId === targetId));
  const lines = rest.split("\n");
  const s = sections(rest)[index];
  const at = endOf(lines, s);
  const texts = parts.map(p => partText(notes[p.noteId].body, p)).filter(Boolean);
  const plain = texts.filter(t => !hasHeading(t));
  const headed = texts.filter(hasHeading).map(t => alignTo(t, s.depth ? Math.min(6, s.depth + 1) : 2));
  const insert = [];
  const afterHeading = at === s.start + 1 && s.depth;
  if (plain.length) {
    if (asTask) {
      // Joined to the list the section ends with; else right below the heading or after a blank line.
      if (!endsWithTasks(lines, s) && !afterHeading && at > 0) insert.push("");
      insert.push(asTasks(plain.join("\n\n")));
    } else {
      if (!afterHeading && at > 0) insert.push("");
      insert.push(copyText(plain));
    }
  }
  if (headed.length) insert.push("", copyText(headed));
  if (at < lines.length && lines[at].trim() && !ATX.test(lines[at])) insert.push(""); // a heading needs no blank line before it
  const out = [...lines.slice(0, at), ...insert.join("\n").split("\n"), ...lines.slice(at)].join("\n").replace(/^\n+/, "");
  const sources = Object.keys(notes).filter(id => id !== targetId && parts.some(p => p.noteId === id));
  return {
    body: out,
    changes: sources.map(id => ({ id, body: withoutParts(notes[id].body, parts.filter(p => p.noteId === id)) })),
  };
}

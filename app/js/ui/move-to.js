// Move to… (docs/requirements.md → "Multi-select" → "Move to"): picks a
// section of another note and moves the parts there (core/move.js). Opened
// from the selection bar and from a row of the Tidy up dialog (ui/arrange.js).
// Every note with its headings in one list, one tap picks (decided 2026-10-19
// over note first, then section: fewer taps); − / + set the levels shown, as
// in the contents.
import { noteTitle } from "../core/markdown.js";
import { moveOutline, moveInto, targetRest } from "../core/move.js";
import { partText } from "../core/selection.js";
import { state, note, circleOf, applyMoveInto, updateSettings } from "../store.js";
import { icon } from "./icons.js";
import { refOf } from "../core/note-ref.js";

const $ = id => document.getElementById(id);
let pick = null;   // { parts, sources, candidates, onDone, target: { id, index, text } }

const ATX = /^ {0,3}#{1,6}(\s|$)/m;

/**
 * Opens the picker for `parts` ([{ noteId, from, to, whole }]) of the notes
 * `sources` (by id) over the `candidates` (notes, in the list's order);
 * after the move `onDone(targetId, undo, message)`.
 */
export function moveTo({ parts, sources, candidates, onDone }) {
  const wholeIds = new Set(parts.filter(p => p.whole).map(p => p.noteId));
  pick = { parts, sources, candidates: candidates.filter(n => !wholeIds.has(refOf(n)) && !n.news), onDone, target: null };
  const plain = parts.some(p => !ATX.test(partText(sources[p.noteId].body, p)));
  $("moveTaskRow").dataset.plain = plain ? "1" : "";
  $("moveTitle").textContent = parts.length === 1 ? (parts[0].whole ? "Move note to…" : parts[0].item ? "Move item to…" : "Move section to…") : `Move ${parts.length} parts to…`;
  $("moveSearch").value = "";
  render();
  $("moveDialog").hidden = false;
}

const isOpen = () => !$("moveDialog").hidden;

function close() {
  pick = null;
  $("moveDialog").hidden = true;
}

// The candidate's sections, without the parts of it that move.
function outline(n) {
  const id = refOf(n);
  return moveOutline(targetRest(n.body, pick.parts.filter(p => p.noteId === id)));
}

function matches(n, q) {
  if (!q) return true;
  return [noteTitle(n.body).text, ...outline(n).map(r => r.text)].some(t => t.toLowerCase().includes(q));
}

// A note's sections with their level in the picker: the note itself is level 1, its headings count from
// its highest one (as in the contents).
function leveled(n) {
  const rows = outline(n);
  const top = Math.min(...rows.slice(1).map(r => r.depth || 99));
  return rows.map(r => ({ ...r, level: r.index === 0 ? 1 : 1 + Math.max(1, (r.depth || top) - top + 1) }));
}

function render() {
  const q = $("moveSearch").value.trim().toLowerCase();
  const notes = pick.candidates.filter(c => matches(c, q)).map(n => [n, leveled(n)]);
  const maxLevel = Math.max(1, ...notes.flatMap(([, rows]) => rows.map(r => r.level)));
  const depth = Math.min(state.settings.moveDepth || 2, maxLevel);
  $("moveDepth").textContent = depth;
  $("moveLess").disabled = depth <= 1;
  $("moveMore").disabled = depth >= maxLevel;
  const rows = [];
  for (const [n, sections] of notes) {
    // A search shows every level of the notes it finds.
    const shown = sections.filter(r => q || r.level <= depth);
    const hidden = sections.length - shown.length;
    shown.forEach(r => rows.push(row(n, r, r.level - 1, r.index === 0 ? hidden : 0)));
  }
  if (!rows.length) {
    const li = document.createElement("li");
    li.className = "move-empty";
    li.textContent = "No note matches";
    rows.push(li);
  }
  $("moveList").replaceChildren(...rows);
  footer();
}

// A section to pick; the note's first section stands for the note (`more`: its sections on hidden levels).
function row(n, r, indent, more) {
  const id = refOf(n);
  const li = document.createElement("li");
  const b = document.createElement("button");
  b.type = "button";
  b.className = "move-row" + (r.index === 0 ? " head" : "") + (r.fromHeading ? "" : " plain");
  b.style.setProperty("--indent", indent);
  b.setAttribute("aria-pressed", String(pick.target?.id === id && pick.target.index === r.index));
  const label = document.createElement("span");
  label.className = "move-text";
  label.textContent = r.text || "Untitled";
  b.append(label);
  if (more) b.insertAdjacentHTML("beforeend", `<span class="move-more">+${more}</span>`);
  if (r.tasks) b.insertAdjacentHTML("beforeend", `<span class="move-tag">${icon("checkbox")}</span>`);
  b.addEventListener("click", () => choose(id, r));
  li.append(b);
  return li;
}

function choose(id, r) {
  pick.target = { id, index: r.index, text: r.text };
  $("moveTask").checked = r.tasks;
  const top = $("moveList").scrollTop;
  render();
  $("moveList").scrollTop = top;
}

// Where it lands and the task switch.
function footer() {
  const t = pick.target;
  $("moveOk").disabled = !t;
  $("moveTaskRow").hidden = !t || !$("moveTaskRow").dataset.plain;
  const n = t && note(t.id);
  $("moveWhere").textContent = t ? `End of “${t.text || "Untitled"}”${t.index ? ` in “${noteTitle(n.body).text || "Untitled"}”` : ""}` : "Pick where it goes.";
}

function confirm() {
  const { parts, sources, onDone, target } = pick;
  const asTask = !$("moveTaskRow").hidden && $("moveTask").checked;
  close();
  const notes = { ...sources, [target.id]: note(target.id) };
  const m = moveInto(notes, parts, target.id, target.index, { asTask });
  const undo = applyMoveInto(target.id, m.body, m.changes);
  onDone(target.id, undo, `Moved to “${target.text || "Untitled"}”`);
}

export function initMoveTo() {
  $("moveLess").innerHTML = icon("minus");
  $("moveMore").innerHTML = icon("plus");
  const step = delta => { updateSettings({ moveDepth: Math.max(1, Number($("moveDepth").textContent) + delta) }); render(); };
  $("moveLess").addEventListener("click", () => step(-1));
  $("moveMore").addEventListener("click", () => step(1));
  $("moveSearch").addEventListener("input", () => render());
  $("moveCancel").addEventListener("click", close);
  $("moveOk").addEventListener("click", confirm);
  $("moveDialog").addEventListener("click", e => { if (e.target === $("moveDialog")) close(); });
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape" || !isOpen()) return;
    e.stopImmediatePropagation();
    close();
  }, true);
}

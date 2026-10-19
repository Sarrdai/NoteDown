// Move to… (docs/requirements.md → "Multi-select" → "Move to"): picks a
// section of another note and moves the parts there (core/move.js). Opened
// from the selection bar and from a row of the Tidy up dialog (ui/arrange.js).
// Prototype variants of the picker (setting `movePicker`):
//   "outline" (A) — every note with its headings in one list, one tap picks;
//   "steps"   (B) — the notes first, a tap on one shows its sections.
import { noteTitle } from "../core/markdown.js";
import { moveOutline, moveInto, targetRest } from "../core/move.js";
import { partText } from "../core/selection.js";
import { keepsPart } from "../core/sharing.js";
import { state, note, circleOf, applyMoveInto } from "../store.js";
import { membersLabel } from "./people.js";
import { icon } from "./icons.js";
import { refOf } from "../core/note-ref.js";

const $ = id => document.getElementById(id);
let pick = null;   // { parts, sources, candidates, onDone, open: id (steps variant), target: { id, index } }

const ATX = /^ {0,3}#{1,6}(\s|$)/m;
const variant = () => state.settings.movePicker || "outline";

/**
 * Opens the picker for `parts` ([{ noteId, from, to, whole }]) of the notes
 * `sources` (by id) over the `candidates` (notes, in the list's order);
 * after the move `onDone(targetId, undo, message)`.
 */
export function moveTo({ parts, sources, candidates, onDone }) {
  const wholeIds = new Set(parts.filter(p => p.whole).map(p => p.noteId));
  pick = { parts, sources, candidates: candidates.filter(n => !wholeIds.has(refOf(n)) && !n.news), onDone, open: null, target: null };
  const plain = parts.some(p => !ATX.test(partText(sources[p.noteId].body, p)));
  $("moveTaskRow").dataset.plain = plain ? "1" : "";
  $("moveTitle").textContent = parts.length === 1 ? (parts[0].whole ? "Move note to…" : "Move section to…") : `Move ${parts.length} parts to…`;
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

function render() {
  const q = $("moveSearch").value.trim().toLowerCase();
  const steps = variant() === "steps";
  const opened = steps && pick.open && pick.candidates.find(n => refOf(n) === pick.open);
  $("moveBack").hidden = !opened;
  $("moveSearch").hidden = !!opened;
  $("moveSub").hidden = !opened;
  if (opened) $("moveSub").textContent = `Into “${noteTitle(opened.body).text || "Untitled"}”`;
  const rows = [];
  if (opened) {
    const sections = outline(opened);
    const top = Math.min(...sections.map(r => r.depth || 99));
    for (const r of sections) rows.push(row(opened, r, r.depth ? r.depth - top : 0, r.index === 0));
  } else {
    for (const n of pick.candidates.filter(c => matches(c, q))) {
      const sections = outline(n);
      if (steps) { rows.push(noteRow(n, sections)); continue; }
      const top = Math.min(...sections.map(r => r.depth || 99));
      sections.forEach(r => rows.push(row(n, r, r.index === 0 ? 0 : Math.max(1, r.depth - top), r.index === 0)));
    }
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

// A section to pick; `head`: the note's first section, shown as the note.
function row(n, r, indent, head) {
  const id = refOf(n);
  const li = document.createElement("li");
  const b = document.createElement("button");
  b.type = "button";
  b.className = "move-row" + (head ? " head" : "") + (r.fromHeading ? "" : " plain");
  b.style.setProperty("--indent", indent);
  b.setAttribute("aria-pressed", String(pick.target?.id === id && pick.target.index === r.index));
  const label = document.createElement("span");
  label.className = "move-text";
  label.textContent = r.text || "Untitled";
  b.append(label);
  if (r.tasks) b.insertAdjacentHTML("beforeend", `<span class="move-tag">${icon("checkbox")}</span>`);
  b.addEventListener("click", () => choose(id, r));
  li.append(b);
  return li;
}

// Steps variant: a note; a tap opens its sections (one section: picks it).
function noteRow(n, sections) {
  const id = refOf(n);
  const li = document.createElement("li");
  const b = document.createElement("button");
  b.type = "button";
  const t = noteTitle(n.body);
  b.className = "move-row head" + (t.fromHeading ? "" : " plain");
  b.setAttribute("aria-pressed", String(sections.length === 1 && pick.target?.id === id));
  const label = document.createElement("span");
  label.className = "move-text";
  label.textContent = t.text || "Untitled";
  b.append(label);
  if (sections.length > 1) b.insertAdjacentHTML("beforeend", `<span class="move-count">${sections.length - 1}</span><span class="move-chevron">${icon("back")}</span>`);
  else if (sections[0].tasks) b.insertAdjacentHTML("beforeend", `<span class="move-tag">${icon("checkbox")}</span>`);
  b.addEventListener("click", () => {
    if (sections.length === 1) return choose(id, sections[0]);
    pick.open = id;
    render();
    $("moveList").scrollTop = 0;
  });
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

// Where it lands, the task switch and what shared sources keep.
function footer() {
  const t = pick.target;
  $("moveOk").disabled = !t;
  $("moveTaskRow").hidden = !t || !$("moveTaskRow").dataset.plain;
  const n = t && note(t.id);
  $("moveWhere").textContent = t ? `End of “${t.text || "Untitled"}”${t.index ? ` in “${noteTitle(n.body).text || "Untitled"}”` : ""}` : "Pick where it goes.";
  const kept = t ? [...new Set(Object.keys(pick.sources).filter(id => id !== t.id && keepsPart(circleOf(id), circleOf(t.id))).flatMap(circleOf))] : [];
  $("moveKeep").hidden = !kept.length;
  $("moveKeep").textContent = kept.length ? `Notes shared with ${membersLabel(kept)} keep their part for them.` : "";
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
  $("moveBack").innerHTML = icon("back");
  $("moveBack").addEventListener("click", () => { pick.open = null; render(); });
  $("moveSearch").addEventListener("input", () => render());
  $("moveCancel").addEventListener("click", close);
  $("moveOk").addEventListener("click", confirm);
  $("moveDialog").addEventListener("click", e => { if (e.target === $("moveDialog")) close(); });
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape" || !isOpen()) return;
    e.stopImmediatePropagation();
    if (pick.open) { pick.open = null; render(); } else close();
  }, true);
}

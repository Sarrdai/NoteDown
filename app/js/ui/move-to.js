// Move to… (docs/requirements.md → "Multi-select" → "Move to"): the one way to move things far — picks a
// section of another note and moves the parts there (core/move.js), or "New note" (merging several parts,
// splitting one off; decided 2026-10-24 over a Merge action of its own), or for whole notes in the Shelves a
// shelf. Copy to… is the same picker for a passage marked in the editor, whose note keeps it. Opened from the
// selection bar, the editor's toolbar and a row of the Tidy up dialog (ui/arrange.js). Every note with its
// headings in one list, one tap picks (decided 2026-10-19 over note first, then section: fewer taps); − / +
// set the levels shown, as in the contents.
import { noteTitle } from "../core/markdown.js";
import { moveOutline, moveInto, targetRest, insertText } from "../core/move.js";
import { partText } from "../core/selection.js";
import { state, note, setBody, applyMoveInto, updateSettings } from "../store.js";
import { icon } from "./icons.js";
import { avatarStackHtml, membersLabel, esc } from "./people.js";
import { refOf } from "../core/note-ref.js";

const $ = id => document.getElementById(id);
// { parts, sources, text, candidates, onDone, newNote, shelves, target }; target: { kind: "section", id, index,
// text } | { kind: "new" } | { kind: "shelf", id, title }
let pick = null;

const ATX = /^ {0,3}#{1,6}(\s|$)/m;

/**
 * Opens the picker for `parts` ([{ noteId, from, to, whole }]) of the notes `sources` (by id) — or, copying,
 * for a passage `text` — over the `candidates` (notes, in the list's order); after the move or copy
 * `onDone(targetId, undo, message)`. `newNote` ({ shareWith, run(mode) } or null) offers "New note": `run`
 * gets "copy" | "share" (the choice offered when `shareWith`, member ids, is set). `shelves` ({ list: [{ id,
 * title }], place(id) → undo } or null) offers the shelves for whole notes.
 */
export function moveTo({ parts = [], sources = {}, text = null, candidates, onDone, newNote = null, shelves = null }) {
  const wholeIds = new Set(parts.filter(p => p.whole).map(p => p.noteId));
  pick = { parts, sources, text, candidates: candidates.filter(n => !wholeIds.has(refOf(n)) && !n.news), onDone, newNote, shelves, target: null };
  const plain = text !== null ? !ATX.test(text) : parts.some(p => !ATX.test(partText(sources[p.noteId].body, p)));
  $("moveTaskRow").dataset.plain = plain ? "1" : "";
  $("moveTitle").textContent = text !== null ? "Copy to…"
    : parts.length === 1 ? (parts[0].whole ? "Move note to…" : parts[0].item ? "Move item to…" : "Move section to…") : `Move ${parts.length} parts to…`;
  $("moveOk").textContent = text !== null ? "Copy" : "Move";
  $("moveChoice").innerHTML = newNote?.shareWith ? choiceHtml("copy", "Private copy", "Shared notes stay as they are.", true)
    + choiceHtml("share", `Share with ${esc(membersLabel(newNote.shareWith))}`, "Everything merged becomes visible to them.", false, avatarStackHtml(newNote.shareWith)) : "";
  $("moveSearch").value = "";
  render();
  $("moveDialog").hidden = false;
}

function choiceHtml(value, title, hint, checked, extra = "") {
  return `<label class="choice"><input type="radio" name="moveMode" value="${value}"${checked ? " checked" : ""}>`
    + `<span class="choice-text"><span class="choice-title">${title}</span><span class="choice-hint">${hint}</span></span>${extra}</label>`;
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
  // "New note" heads the list (decided 2026-10-24 over a button under it: in sight, one tap).
  if (pick.newNote && !q) rows.push(special({ kind: "new" }, "plus", "New note"));
  if (pick.shelves && !q) rows.push(...pick.shelves.list.map(sh => special({ kind: "shelf", id: sh.id, title: sh.title }, "shelf", sh.title)));
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
  b.setAttribute("aria-pressed", String(pick.target?.kind === "section" && pick.target.id === id && pick.target.index === r.index));
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

// A row that isn't a note's section: "New note" or a shelf.
function special(target, ic, text) {
  const li = document.createElement("li");
  const b = document.createElement("button");
  b.type = "button";
  b.className = "move-row head special";
  b.setAttribute("aria-pressed", String(pick.target?.kind === target.kind && pick.target.id === target.id));
  b.innerHTML = `<span class="move-lead">${icon(ic)}</span><span class="move-text"></span>`;
  b.querySelector(".move-text").textContent = text;
  b.addEventListener("click", () => setTarget(target));
  li.append(b);
  return li;
}

function choose(id, r) {
  $("moveTask").checked = r.tasks;
  setTarget({ kind: "section", id, index: r.index, text: r.text });
}

function setTarget(target) {
  pick.target = target;
  const top = $("moveList").scrollTop;
  render();
  $("moveList").scrollTop = top;
}

// Where it lands, the task switch and, for a new note of shared parts, where that note goes.
function footer() {
  const t = pick.target;
  $("moveOk").disabled = !t;
  $("moveTaskRow").hidden = t?.kind !== "section" || !$("moveTaskRow").dataset.plain;
  $("moveChoice").hidden = t?.kind !== "new" || !pick.newNote?.shareWith;
  const n = t?.kind === "section" && note(t.id);
  $("moveWhere").textContent = !t ? "Pick where it goes."
    : t.kind === "new" ? "A new note"
    : t.kind === "shelf" ? `End of the shelf “${t.title}”`
    : `End of “${t.text || "Untitled"}”${t.index ? ` in “${noteTitle(n.body).text || "Untitled"}”` : ""}`;
}

function confirm() {
  const { parts, sources, text, onDone, newNote, shelves, target } = pick;
  const asTask = !$("moveTaskRow").hidden && $("moveTask").checked;
  const mode = $("moveChoice").querySelector("input:checked")?.value || "copy";
  close();
  if (target.kind === "new") return newNote.run(mode);
  if (target.kind === "shelf") return onDone(null, shelves.place(target.id), `Moved to the shelf “${target.title}”`);
  const where = `“${target.text || "Untitled"}”`;
  if (text !== null) {
    const before = note(target.id).body;
    setBody(target.id, insertText(before, target.index, text, { asTask }));
    return onDone(target.id, () => setBody(target.id, before), `Copied to ${where}`);
  }
  const notes = { ...sources, [target.id]: note(target.id) };
  const m = moveInto(notes, parts, target.id, target.index, { asTask });
  const undo = applyMoveInto(target.id, m.body, m.changes);
  onDone(target.id, undo, `Moved to ${where}`);
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

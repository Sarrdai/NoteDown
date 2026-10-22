// Drag and drop of list items and sections (docs/requirements.md → "Multi-select" → "Drag and drop"), in the
// main view: on the desktop by the grip that shows at the right of the list item or heading under the mouse
// (a click on it selects), on touch by moving the finger after the long-press (ui/selection.js). The part
// follows the pointer as a floating copy; a line shows where it lands — between the items of any list, at
// the end of a section, before a heading or at a note's end, in any note of the view — and with its left
// edge the level: moving sideways nests it deeper or less deep. Near the window's top or bottom edge the
// list scrolls along. Letting go moves it (core/drag.js), with Undo.
import { state, note, setBody, applyMoveInto } from "../store.js";
import { itemSlots, sectionSlots, sectionRange, moveItem, moveSection } from "../core/drag.js";
import { listItems } from "../core/list-items.js";
import { sections, noteTitle } from "../core/markdown.js";
import { showPick, pickAt, isSelecting, endSelection } from "./selection.js";
import { showSnackbar } from "./snackbar.js";
import { icon } from "./icons.js";

let opts = null;   // { onMoved(targetId, undo, message) }
let drag = null;   // while dragging: { src, range, from, level0, els, ghost, line, grab, x, y, x0, slot, frame }
let grip = null;   // the desktop's grip and what it moves: { el, at }

const $ = id => document.getElementById(id);

export const isDragging = () => !!drag;

export function initDragDrop(options) {
  opts = options;
  initGrip();
}

/** What can be dragged at `target`: a list item or a heading's section of an open note in the main view, not
 *  the edited one — { noteId, kind: "item" | "section", el, head, line } — or null. */
export function draggableAt(target) {
  if (state.view !== "open") return null;
  const card = target?.closest?.("#list .note");
  if (!card || card.dataset.id === state.editingId) return null;
  const noteId = card.dataset.id;
  const n = note(noteId);
  if (!n || n.status === "closed" || n.news || n.deleted) return null;
  const li = target.closest(".note-body li[data-line]");
  if (li) return { noteId, kind: "item", el: li, head: li, line: Number(li.dataset.line) };
  const h = target.closest(".note-body .md-section > :is(h1, h2, h3, h4, h5, h6):first-child");
  const s = h && sections(n.body)[Number(h.parentElement.dataset.section)];
  return s?.depth ? { noteId, kind: "section", el: h.parentElement, head: h, line: s.start } : null;
}

// ---------- the desktop's grip ----------

function initGrip() {
  const el = document.createElement("button");
  el.className = "drag-grip";
  el.setAttribute("aria-label", "Drag to move · click to select");
  el.title = "Drag to move · click to select";
  el.innerHTML = icon("grip");
  grip = { el, at: null };
  $("list").addEventListener("pointermove", e => {
    if (e.pointerType !== "mouse" || e.buttons || drag || e.target.closest(".drag-grip")) return;
    placeGrip(draggableAt(e.target));
  });
  $("list").addEventListener("pointerleave", () => { if (!drag) placeGrip(null); });
  el.addEventListener("pointerenter", () => { if (!drag) showPick(grip.at?.el); });
  el.addEventListener("pointerleave", () => { if (!drag) showPick(null); });
  el.addEventListener("pointerdown", onGripDown);
}

// Shows the grip at the right end of the part's first line (its card holds it), or hides it.
function placeGrip(at) {
  grip.at = at;
  const card = at?.el.closest(".note");
  if (!at || !card) { grip.el.remove(); return; }
  if (grip.el.parentElement !== card) card.append(grip.el);
  const head = at.head.getBoundingClientRect();
  const lineH = parseFloat(getComputedStyle(at.head).lineHeight) || head.height;
  grip.el.style.top = `${head.top - card.getBoundingClientRect().top + Math.min(lineH, head.height) / 2}px`;
}

function onGripDown(e) {
  if (e.button !== 0 || !grip.at) return;
  e.preventDefault();
  e.stopPropagation();
  const at = grip.at;
  const x0 = e.clientX, y0 = e.clientY;
  const move = ev => {
    if (!drag && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 4) { showPick(null); placeGrip(null); startDrag(at, x0, y0); }
    if (drag) moveDrag(ev.clientX, ev.clientY);
  };
  // On the window: the grip leaves its card when the drag starts.
  const up = ev => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    if (drag) return endDrag(ev.type === "pointerup");
    // A click on the grip selects the part, as Ctrl+click does.
    showPick(null);
    pickAt(at.head);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

// ---------- dragging ----------

// A list item's lines and indent, or a section's lines and depth.
function sourceOf(src) {
  const body = note(src.noteId).body;
  if (src.kind === "section") return sectionRange(body, src.line);
  const it = listItems(body).find(i => i.line === src.line);
  return it && { lines: [it.line, it.end], indent: it.indent };
}

/** Starts dragging `src` (draggableAt) from the pointer at x, y. */
export function startDrag(src, x, y) {
  const from = sourceOf(src);
  if (!from) return;
  // The elements that move: the item, or the heading's section with the deeper ones below it.
  const els = [src.el];
  if (src.kind === "section") {
    const ss = sections(note(src.noteId).body);
    for (let g = src.el.nextElementSibling; g && ss[Number(g.dataset.section)]?.start < from.lines[1]; g = g.nextElementSibling) els.push(g);
  }
  const r = src.el.getBoundingClientRect();
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost md";
  ghost.style.width = `${r.width}px`;
  if (src.kind === "item") {
    const list = document.createElement(src.el.parentElement.tagName);
    list.append(src.el.cloneNode(true));
    ghost.append(list);
  } else ghost.append(...els.map(g => g.cloneNode(true)));
  ghost.querySelectorAll(".drag-grip").forEach(g => g.remove());
  const line = document.createElement("div");
  line.className = "drop-line";
  document.body.append(ghost, line);
  for (const el of els) el.classList.add("drag-source");
  document.body.classList.add("dragging-part");
  const level0 = src.kind === "section" ? from.depth : countLevels(src.el);
  drag = { src, range: from.lines, from: src.kind === "section" ? from.depth : from.indent, level0, els, ghost, line, grab: { dx: x - r.left, dy: y - r.top }, x, y, x0: x, slot: null, frame: 0 };
  try { navigator.vibrate?.(15); } catch { /* not allowed */ }
  moveDrag(x, y);
}

const countLevels = li => { let n = 0; for (let p = li.parentElement.closest("li"); p; p = p.parentElement.closest("li")) n++; return n; };

/** Moves the dragged part to the pointer at x, y. */
export function moveDrag(x, y) {
  if (!drag) return;
  Object.assign(drag, { x, y });
  drag.ghost.style.transform = `translate(${x - drag.grab.dx}px, ${y - drag.grab.dy}px)`;
  drag.slot = nearestSlot();
  drawLine();
  if (!drag.frame) drag.frame = requestAnimationFrame(autoScroll);
}

// The visible part of the list: below the top bar (or the selection bar).
const viewTop = () => Math.max(0, ...[$("topbar"), $("selectBar")].filter(el => el && !el.hidden && el.offsetParent).map(el => el.getBoundingClientRect().bottom));

function autoScroll() {
  if (!drag) return;
  const step = drag.y < viewTop() + 40 ? -12 : drag.y > window.innerHeight - 60 ? 12 : 0;
  if (step) { window.scrollBy(0, step); moveDrag(drag.x, drag.y); }
  drag.frame = step ? requestAnimationFrame(autoScroll) : 0;
}

// The cards a part may land in: open notes of the view, not the edited one.
function targets() {
  return [...$("list").querySelectorAll(".note[data-id]")].filter(card => {
    const n = note(card.dataset.id);
    return n && n.status !== "closed" && !n.news && !n.deleted && card.dataset.id !== state.editingId;
  });
}

// Every place the part may land, on the screen: [{ noteId, line, y, left, right, levels, gap }] — `levels`
// [{ value (indent or depth), level, x }].
function screenSlots() {
  const out = [];
  const { src } = drag;
  for (const card of targets()) {
    const id = card.dataset.id;
    const body = note(id).body;
    const skip = id === src.noteId ? drag.range : null;
    const bodyEl = card.querySelector(".note-body");
    const box = bodyEl.getBoundingClientRect();
    const step = 1.4 * parseFloat(getComputedStyle(bodyEl).fontSize);
    if (src.kind === "item") {
      for (const s of itemSlots(body, skip)) {
        const y = itemY(bodyEl, s.anchor);
        if (y === null) continue;
        out.push({ noteId: id, line: s.line, y, left: box.left, right: box.right, gap: !!s.gap,
          levels: s.levels.map(l => ({ value: l.indent, level: l.level, x: box.left + step * (l.level + 1) - 6 })) });
      }
    } else {
      const slots = sectionSlots(body, skip);
      const top = Math.min(...slots.flatMap(s => s.depths));
      for (const s of slots) {
        const groups = bodyEl.querySelectorAll(".md-section");
        const y = s.anchor.end ? endY(groups[groups.length - 1]) : bodyEl.querySelector(`.md-section[data-section="${s.anchor.section}"]`)?.getBoundingClientRect().top;
        if (y == null) continue;
        out.push({ noteId: id, line: s.line, y, left: box.left, right: box.right,
          levels: s.depths.map(d => ({ value: d, level: d, x: box.left + step * (d - top) })) });
      }
    }
  }
  return out;
}

// Where an item slot shows: above an item, below a list's last item, or at the end of a section's own text
// (above a closing line of labels).
function itemY(bodyEl, anchor) {
  if (anchor.before !== undefined) return bodyEl.querySelector(`li[data-line="${anchor.before}"]`)?.getBoundingClientRect().top ?? null;
  if (anchor.after !== undefined) return bodyEl.querySelector(`li[data-line="${anchor.after}"]`)?.getBoundingClientRect().bottom ?? null;
  return endY(bodyEl.querySelector(`.md-section[data-section="${anchor.sectionEnd}"]`));
}

// The end of a section group's own text: above a closing line of labels, else its bottom.
function endY(g) {
  if (!g) return null;
  const last = g.lastElementChild;
  const labels = last?.tagName === "P" && [...last.childNodes].every(c => c.nodeType === 1 ? c.classList.contains("label-chip") : !c.textContent.trim());
  return labels ? last.getBoundingClientRect().top : g.getBoundingClientRect().bottom;
}

// The slot nearest the pointer, on the level the sideways movement asks for.
function nearestSlot() {
  let best = null;
  const top = viewTop(), bottom = window.innerHeight;
  for (const s of screenSlots()) {
    if (s.y < top || s.y > bottom) continue;   // only where the line can be seen
    if (!best || Math.abs(s.y - drag.y) < Math.abs(best.y - drag.y)) best = s;
  }
  if (!best) return null;
  const step = 1.4 * parseFloat(getComputedStyle(document.body).fontSize);
  const want = drag.level0 + Math.round((drag.x - drag.x0) / step);
  const level = best.levels.reduce((a, l) => (Math.abs(l.level - want) < Math.abs(a.level - want) ? l : a));
  return { ...best, level };
}

function drawLine() {
  const { slot, line, src } = drag;
  line.hidden = !slot;
  if (!slot) return;
  line.style.transform = `translate(${slot.level.x}px, ${slot.y - 1}px)`;
  line.style.width = `${Math.max(40, slot.right - slot.level.x)}px`;
  line.dataset.label = src.kind === "section" ? `H${slot.level.value}` : "";
}

/** Ends the drag: moves the part to the slot when `commit`, else puts it back. */
export function endDrag(commit) {
  if (!drag) return;
  const { src, slot, range, from, ghost, line, els, frame } = drag;
  cancelAnimationFrame(frame);
  ghost.remove();
  line.remove();
  for (const el of els) el.classList.remove("drag-source");
  document.body.classList.remove("dragging-part");
  drag = null;
  if (commit && slot) drop(src, slot, range, from);
}

function drop(src, slot, range, from) {
  const same = slot.noteId === src.noteId;
  const srcBody = note(src.noteId).body;
  const dstBody = same ? null : note(slot.noteId).body;
  const m = src.kind === "item"
    ? moveItem(srcBody, range, from, dstBody, slot.line, slot.level.value, { gap: slot.gap })
    : moveSection(srcBody, range, from, dstBody, slot.line, slot.level.value);
  if (same && m.src === srcBody) return;
  if (isSelecting()) endSelection();
  if (same) {
    setBody(src.noteId, m.src);
    showSnackbar("Moved", () => setBody(src.noteId, srcBody));
    return;
  }
  const undo = applyMoveInto(slot.noteId, m.dst, [{ id: src.noteId, body: m.src }]);
  opts.onMoved(slot.noteId, undo, `Moved to “${noteTitle(note(slot.noteId).body).text || "Untitled"}”`);
}

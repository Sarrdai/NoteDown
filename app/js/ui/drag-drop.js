// Drag and drop of list items and sections (docs/requirements.md → "Multi-select" → "Drag and drop"), in the
// main view: on the desktop by the grip that shows at the right of the list item or heading under the mouse
// (a click on it selects), on touch by moving the finger after the long-press (ui/selection.js). The part
// follows the pointer as a floating copy; a line shows where it lands — between the items of any list, at
// the end of a section, before a heading or at a note's end, in any note of the view — and with its left
// edge the level: moving sideways nests it deeper or less deep. Near the window's top or bottom edge the
// list scrolls along. Letting go moves it (core/drag.js), with Undo. Dragged by a selected part's grip, the
// other selected parts of its kind move along (`group`, ui/selection.js → dragGroup) and land together.
// The contents are a target too (tocSlot): on an entry it lands at the end of that section, on the upper edge
// of a heading's entry (sections only) before it; on the phone, held over the sheet's handle, the sheet opens.
// With the Shelves, whole notes move too (startNoteDrag): between the notes and to a shelf's end, changing
// the order only.
import { state, note, setBody, applyMoveInto } from "../store.js";
import { itemSlots, sectionSlots, sectionRange, moveItem, moveSection, moveParts } from "../core/drag.js";
import { listItems } from "../core/list-items.js";
import { sections, noteTitle } from "../core/markdown.js";
import { placeInOrder } from "../core/query.js";
import { showPick, pickAt, isSelecting, endSelection } from "./selection.js";
import { setTocOpen } from "./toc.js";
import { showSnackbar } from "./snackbar.js";
import { icon } from "./icons.js";

let opts = null;   // { onMoved(targetId, undo, message), order() → { ids, set(ids) → undo } | null (not the Shelves) }
let drag = null;   // while dragging: { src, range, from, group, level0, els, ghost, line, grab, x, y, x0, slot, frame, dwell, opened }
const DWELL_MS = 450;   // held this long over the phone's contents handle, the sheet opens
const phone = window.matchMedia("(max-width: 599px)");
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
  // Relative to the card's padding box (inside its border).
  grip.el.style.top = `${head.top - card.getBoundingClientRect().top - card.clientTop + Math.min(lineH, head.height) / 2}px`;
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

// The elements a part covers: the item, or the heading's section with the deeper ones below it.
function elementsOf(noteId, kind, [a, b]) {
  const card = $("list").querySelector(`.note[data-id="${CSS.escape(noteId)}"]`);
  if (!card) return [];
  if (kind === "item") return [card.querySelector(`.note-body li[data-line="${a}"]`)].filter(Boolean);
  const ss = sections(note(noteId).body);
  return [...card.querySelectorAll(".note-body .md-section")].filter(g => { const s = ss[Number(g.dataset.section)]; return s && s.start >= a && s.start < b; });
}

/** Starts dragging `src` (draggableAt) from the pointer at x, y — with the other parts of `group` (dragGroup). */
export function startDrag(src, x, y, group = null) {
  const from = sourceOf(src);
  if (!from) return;
  const els = group ? group.flatMap(p => elementsOf(p.noteId, src.kind, p.lines)) : elementsOf(src.noteId, src.kind, from.lines);
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
  if (group) ghost.dataset.count = group.length;
  const line = document.createElement("div");
  line.className = "drop-line";
  document.body.append(ghost, line);
  for (const el of els) el.classList.add("drag-source");
  document.body.classList.add("dragging-part");
  const level0 = src.kind === "section" ? from.depth : countLevels(src.el);
  drag = { src, range: from.lines, from: src.kind === "section" ? from.depth : from.indent, group, level0, els, ghost, line, grab: { dx: x - r.left, dy: y - r.top }, x, y, x0: x, slot: null, frame: 0 };
  try { navigator.vibrate?.(15); } catch { /* not allowed */ }
  moveDrag(x, y);
}

const countLevels = li => { let n = 0; for (let p = li.parentElement.closest("li"); p; p = p.parentElement.closest("li")) n++; return n; };

/** Moves the dragged part to the pointer at x, y. */
export function moveDrag(x, y) {
  if (!drag) return;
  Object.assign(drag, { x, y });
  drag.ghost.style.transform = `translate(${x - drag.grab.dx}px, ${y - drag.grab.dy}px)`;
  const notes = drag.src.kind === "note";
  const toc = notes ? null : tocSlot(x, y);
  drag.slot = toc || (notes ? nearestNoteSlot() : nearestSlot());
  drawLine();
  if (!notes) watchHandle(y);
  if (!drag.frame && !toc) drag.frame = requestAnimationFrame(autoScroll);
}

// ---------- the contents as a target ----------

const sheetOpen = () => document.getElementById("app").classList.contains("toc-open");
const handleZone = y => phone.matches && !sheetOpen() && y > window.innerHeight - 44;

// Phone: held over the closed sheet's handle, the sheet opens (and closes again after the drop).
function watchHandle(y) {
  if (!handleZone(y)) { clearTimeout(drag.dwell); drag.dwell = 0; return; }
  if (drag.dwell) return;
  drag.dwell = setTimeout(() => {
    if (!drag) return;
    drag.opened = true;
    setTocOpen(true);
  }, DWELL_MS);
}

// The parts' own lines in note `id` (no target inside them).
const ownRanges = id => drag.group ? drag.group.filter(p => p.noteId === id).map(p => p.lines) : id === drag.src.noteId ? [drag.range] : [];

// The contents entry under the pointer as a slot — { noteId, line, level, gap, entry, before } — or null.
function tocSlot(x, y) {
  for (const old of document.querySelectorAll("#tocList .drop-into")) old.classList.remove("drop-into");
  const entry = document.elementFromPoint(x, y)?.closest("#tocList .toc-entry[data-key]");
  if (!entry || (phone.matches && !sheetOpen())) return null;
  const key = entry.dataset.key;
  const noteId = key.slice(0, key.lastIndexOf("#"));
  const index = Number(key.slice(key.lastIndexOf("#") + 1));
  const n = note(noteId);
  if (!n || n.status === "closed" || n.news || n.deleted || noteId === state.editingId) return null;
  const body = n.body, ss = sections(body), s = ss[index];
  const own = ownRanges(noteId);
  if (!s || own.some(([a, b]) => s.start >= a && s.start < b)) return null;
  const skip = own.length ? own : null;
  const r = entry.getBoundingClientRect();
  let slot = null, before = false;
  if (drag.src.kind === "item") {
    const fits = itemSlots(body, skip).filter(sl => sl.line > s.start && sl.line <= s.end);
    const sl = fits.at(-1);
    if (sl) slot = { line: sl.line, gap: !!sl.gap, level: { value: sl.levels[0].indent } };
  } else if (s.depth && index > 0 && y < r.top + r.height * 0.3) {
    slot = { line: s.start, level: { value: s.depth } };
    before = true;
  } else {
    const end = s.depth ? sectionRange(body, s.start).lines[1] : body.split("\n").length;
    const fits = sectionSlots(body, skip);
    const sl = fits.find(f => f.line >= end) || fits.at(-1);
    slot = { line: sl.line, level: { value: Math.min(6, (s.depth || 1) + 1) } };
  }
  if (!slot) return null;
  if (!before) entry.classList.add("drop-into");
  return { ...slot, noteId, entry, before, y: r.top, left: r.left, right: r.right };
}

// The visible part of the list: below the top bar (or the selection bar).
const viewTop = () => Math.max(0, ...[$("topbar"), $("selectBar")].filter(el => el && !el.hidden && el.offsetParent).map(el => el.getBoundingClientRect().bottom));

function autoScroll() {
  if (!drag) return;
  if (handleZone(drag.y) || (phone.matches && sheetOpen())) { drag.frame = 0; return; }
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
    const own = drag.group ? drag.group.filter(p => p.noteId === id).map(p => p.lines) : id === src.noteId ? [drag.range] : [];
    const skip = own.length ? own : null;
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
  line.hidden = !slot || (slot.entry && !slot.before);
  if (line.hidden) return;
  const x0 = slot.entry ? slot.left : slot.level.x;
  line.style.transform = `translate(${x0}px, ${slot.y - 1}px)`;
  line.style.width = `${Math.max(40, slot.right - x0)}px`;
  line.dataset.label = src.kind === "section" ? `H${slot.level.value}` : "";
}

/** Ends the drag: moves the part to the slot when `commit`, else puts it back. */
export function endDrag(commit) {
  if (!drag) return;
  const { src, slot, range, from, group, ghost, line, els, frame, dwell, opened } = drag;
  cancelAnimationFrame(frame);
  clearTimeout(dwell);
  for (const old of document.querySelectorAll("#tocList .drop-into")) old.classList.remove("drop-into");
  if (opened) setTocOpen(false);
  ghost.remove();
  line.remove();
  for (const el of els) el.classList.remove("drag-source");
  document.body.classList.remove("dragging-part");
  drag = null;
  if (commit && slot) src.kind === "note" ? dropNotes(src.ids, slot) : group ? dropGroup(src.kind, group, slot) : drop(src, slot, range, from);
}

// ---------- whole notes (the Shelves) ----------

/** Starts dragging the note of `card` — with the other selected whole notes in `ids` — from x, y. */
export function startNoteDrag(card, ids, x, y) {
  const r = card.getBoundingClientRect();
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost md note-ghost";
  ghost.style.width = `${r.width}px`;
  ghost.textContent = noteTitle(note(card.dataset.id).body).text || "Untitled";
  if (ids.length > 1) ghost.dataset.count = ids.length;
  const line = document.createElement("div");
  line.className = "drop-line";
  document.body.append(ghost, line);
  const els = ids.map(id => $("list").querySelector(`.note[data-id="${CSS.escape(id)}"]`)).filter(Boolean);
  for (const el of els) el.classList.add("drag-source");
  document.body.classList.add("dragging-part");
  drag = { src: { kind: "note", noteId: card.dataset.id, ids }, els, ghost, line, grab: { dx: x - r.left, dy: Math.min(y - r.top, 24) }, x, y, x0: x, slot: null, frame: 0 };
  try { navigator.vibrate?.(15); } catch { /* not allowed */ }
  moveDrag(x, y);
}

// Before each note of the order and each shelf on the screen (before a shelf: the end of the one above), and
// after the last of them: { before: id | null, y, left, right }. The pile's notes take no slots.
function nearestNoteSlot() {
  const order = opts.order?.();
  if (!order) return null;
  const inOrder = new Set(order.ids);
  const rows = [...$("list").querySelectorAll(".note[data-id], .section-header[data-section]")]
    .map(el => ({ el, id: el.dataset.id ?? el.dataset.section }))
    .filter(r => inOrder.has(r.id) && !drag.src.ids.includes(r.id));
  if (!rows.length) return null;
  const box = $("list").querySelector(".note")?.getBoundingClientRect();
  const slots = rows.map(r => ({ before: r.id, y: r.el.getBoundingClientRect().top - 6 }));
  slots.push({ before: null, y: rows.at(-1).el.getBoundingClientRect().bottom + 6 });
  const top = viewTop();
  let best = null;
  for (const s of slots) if (s.y >= top && s.y <= window.innerHeight && (!best || Math.abs(s.y - drag.y) < Math.abs(best.y - drag.y))) best = s;
  return best && { ...best, left: box.left, right: box.right, level: { x: box.left } };
}

function dropNotes(ids, slot) {
  const order = opts.order?.();
  if (!order) return;
  const next = placeInOrder(order.ids, ids, slot.before);
  if (next.join("\n") === order.ids.join("\n")) return;
  if (isSelecting()) endSelection();
  showSnackbar(ids.length === 1 ? "Moved" : `Moved ${ids.length} notes`, order.set(next));
}

function dropGroup(kind, group, slot) {
  const ids = [...new Set([...group.map(p => p.noteId), slot.noteId])];
  const before = Object.fromEntries(ids.map(id => [id, note(id).body]));
  const out = moveParts(before, group, slot.noteId, slot.line, slot.level.value, kind, { gap: slot.gap });
  endSelection();
  const message = `Moved ${group.length} ${kind === "item" ? "items" : "sections"}`;
  if (ids.length === 1) {
    setBody(slot.noteId, out[slot.noteId]);
    showSnackbar(message, () => setBody(slot.noteId, before[slot.noteId]));
    return;
  }
  const undo = applyMoveInto(slot.noteId, out[slot.noteId], ids.filter(id => id !== slot.noteId).map(id => ({ id, body: out[id] })));
  opts.onMoved(slot.noteId, undo, `${message} to “${noteTitle(note(slot.noteId).body).text || "Untitled"}”`);
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

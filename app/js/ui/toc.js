// Table of contents over the notes in view order: a fixed sidebar on tablet
// and desktop, a bottom sheet on the phone whose handle always peeks out at
// the bottom: a tap on it opens the sheet fully (or closes it), a drag
// anywhere on it moves and scrolls it (initSheetDrag); the Android back key closes it. In the main view it is also a
// way into multi-select (ui/selection.js): a long-press (or Ctrl+click) on
// an entry selects that section with everything below it, then taps add or
// remove entries. Next to the level stepper a switch shows the task progress
// of each section here and at the notes' headings (ui/note-list.js). Sorted
// by a custom order, the pile's header with its Tidy up… link heads the
// entries of the notes not sorted in yet, which come first, as in the list.
import { tableOfContents } from "../core/query.js";
import { sectionProgress } from "../core/tasks.js";
import { state, updateSettings } from "../store.js";
import { flashNote, pileHeader, sectionHeader, onPile, markPileEnd } from "./note-list.js";
import { isSelecting, toggleSection, selectSectionRange } from "./selection.js";
import { pushEntry, leaveEntry } from "./dom.js";
import { markHits } from "./search-hits.js";
import { refOf } from "../core/note-ref.js";

const HOLD_MS = 450;
const MOVE_TOLERANCE = 10;
const SLOP = 8;             // px before a drag's direction is decided (as the view swipe's)
const CLOSE_BELOW = 0.15;   // share of the sheet's range under which a drag closes it
const FLICK = 0.5;          // px/ms: down closes the sheet from anywhere, up from closed opens it fully
const HOLD_STILL_MS = 100;  // a pause this long before letting go is no flick
const GLIDE_DECAY = 0.997;  // per ms: how quickly a flick's glide slows down
const EDGE_STRIP = 24;      // px at either screen edge where a drag up pulls the closed sheet
const EDGE_ZONE = 1 / 3;    // the share of the screen's height, from the bottom, that has these strips

const $ = id => document.getElementById(id);
const app = () => $("app");
const phone = window.matchMedia("(max-width: 599px)");
let press = null;     // { key, x, y, timer } while an entry is held
let swallowClick = false;
let custom = { pileOf: () => ({ pile: null, sectionOf: () => null }), onArrange: null, onTogglePile: null, onToggleSection: null };   // set by initToc

export function renderToc(notes) {
  const { maxLevel } = tableOfContents(notes);
  const depth = Math.min(state.settings.tocDepth, maxLevel);
  $("tocDepth").textContent = depth;
  $("tocLess").disabled = depth <= 1;
  $("tocMore").disabled = depth >= maxLevel;
  $("tocProgress").setAttribute("aria-pressed", String(!!state.settings.tocProgress));
  $("tocList").replaceChildren(...tocItems(notes));
}

/** The entries' elements without placing them (also the view swipe's preview of the other view). */
export function tocItems(notes, search = state.search, view = state.view) {
  const { entries, maxLevel } = tableOfContents(notes);
  const depth = Math.min(state.settings.tocDepth, maxLevel);
  const progress = state.settings.tocProgress && new Map(notes.map(n => [refOf(n), sectionProgress(n.body)]));
  if (!entries.length) return [Object.assign(document.createElement("p"), { className: "toc-empty", textContent: search ? "No matches" : "No notes" })];
  const shown = [];
  const live = view === state.view;
  const onArrange = live && custom.onArrange
    ? () => { if (phone.matches) setTocOpen(false); custom.onArrange(); } : null;
  // Sorted by a custom order: the pile's header above its notes' entries (they come
  // first, after a new note kept on top), then each section heading its notes' entries.
  const { pile, sectionOf } = custom.pileOf(view, notes);
  let piled = !pile;
  const putPile = () => { if (!piled) shown.push(pileHeader(pile, live ? custom.onTogglePile : null, onArrange)); piled = true; };
  const byId = new Map(notes.map(n => [refOf(n), n]));
  let lastNote = null, current = null, folded = false, piling = false;
  entries.forEach((e, i) => {
    if (e.noteId !== lastNote) {
      lastNote = e.noteId;
      if (pile?.has(e.noteId)) {
        putPile();
        current = null;
        piling = true;
        folded = pile.collapsed && e.noteId !== pile.top;
      } else {
        if (e.noteId !== pile?.top) putPile();
        piling = false;
        const s = sectionOf(byId.get(e.noteId));
        if (s && s.id !== current) shown.push(sectionHeader(s, live ? custom.onToggleSection : null));
        current = s?.id ?? null;
        folded = !!s?.collapsed;
      }
    }
    if (folded || e.level > depth) return;
    const b = document.createElement("button");
    b.className = `toc-entry level-${Math.min(e.level, 6)}` + (e.fromHeading ? "" : " plain")
      + (state.selected.has(e.key) ? " selected" : "");
    b.dataset.key = e.key;
    b.textContent = e.text || "Untitled";
    b.title = b.textContent;
    // Selected sections on hidden levels show as "+n" on the visible entry above them.
    let hidden = 0;
    for (let j = i + 1; j < entries.length && entries[j].level > depth; j++) if (state.selected.has(entries[j].key)) hidden++;
    if (hidden) b.insertAdjacentHTML("beforeend", ` <span class="toc-more">+${hidden}</span>`);
    markHits(b, search);
    const p = progress && progress.get(e.noteId)[e.index];
    if (p) b.prepend(progressBadge(p));
    shown.push(piling ? onPile(b) : b);
  });
  putPile();   // the pile is empty, or every entry is a new note's
  markPileEnd(shown);
  return shown;
}

/** "done/total" of a section's tasks, green once all are done. */
export function progressBadge({ done, total }) {
  return Object.assign(document.createElement("span"), {
    className: "task-progress" + (done === total ? " complete" : ""),
    textContent: `${done}/${total}`,
    title: `${done} of ${total} tasks done`,
  });
}

/** `pileOf(view, notes)`: { pile, sectionOf } as ui/note-list.js → listItems takes them (pile null outside a custom order);
 *  `onArrange` opens the arrange dialog, `onTogglePile()` folds the pile, `onToggleSection(id)` a section. */
export function initToc({ pileOf, onArrange, onTogglePile, onToggleSection } = {}) {
  if (pileOf) custom = { pileOf, onArrange, onTogglePile, onToggleSection };
  $("tocLess").addEventListener("click", () => stepDepth(-1));
  $("tocMore").addEventListener("click", () => stepDepth(1));
  $("tocProgress").addEventListener("click", () => {
    updateSettings({ tocProgress: !state.settings.tocProgress });
    $("tocProgress").setAttribute("aria-pressed", String(state.settings.tocProgress));
  });
  $("scrim").addEventListener("click", () => setTocOpen(false));
  window.addEventListener("popstate", () => {
    if (app().classList.contains("toc-open") && !history.state?.toc) setTocOpen(false, { fromHistory: true });
  });
  initSheetDrag();

  const listEl = $("tocList");
  listEl.addEventListener("pointerdown", e => {
    swallowClick = false;
    const el = e.target.closest(".toc-entry");
    if (!el || e.button !== 0 || isSelecting() || state.view !== "open" || e.ctrlKey || e.metaKey || e.shiftKey) return;
    press = { key: el.dataset.key, x: e.clientX, y: e.clientY, timer: setTimeout(onHold, HOLD_MS) };
  });
  listEl.addEventListener("pointermove", e => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE) cancelPress();
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) listEl.addEventListener(type, cancelPress);
  listEl.addEventListener("contextmenu", e => { if (e.target.closest(".toc-entry")) e.preventDefault(); });
  listEl.addEventListener("click", onClick);
}

function cancelPress() {
  if (!press) return;
  clearTimeout(press.timer);
  press = null;
}

function onHold() {
  const { key } = press;
  press = null;
  swallowClick = true; // the click that follows the release
  try { navigator.vibrate?.(15); } catch { /* not allowed */ }
  toggleSection(key);
}

// Selecting works in the main view only: the archive is read-only.
function onClick(e) {
  const el = e.target.closest(".toc-entry");
  if (!el) return;
  if (swallowClick) { swallowClick = false; return; }
  const key = el.dataset.key;
  const selectable = state.view === "open";
  if (selectable && e.shiftKey) selectSectionRange(key);
  else if (selectable && (e.ctrlKey || e.metaKey || isSelecting())) toggleSection(key);
  else jump(key);
}

/** Opens or closes the phone's sheet; `fromHistory` when the back key already left its entry. */
export function setTocOpen(open, { fromHistory = false } = {}) {
  stopGlide();
  $("tocPanel").style.transform = "";   // opening goes to the full height, from the top of the contents
  markOpen(open, fromHistory);
}

let glide = 0;   // the animation frame of the sheet's glide after a flick
function stopGlide() {
  if (!glide) return;
  cancelAnimationFrame(glide);
  glide = 0;
  app().classList.remove("toc-dragging");
}

// The open sheet sits on a history entry (phone only: elsewhere the contents are a sidebar).
function markOpen(open, fromHistory = false) {
  const was = app().classList.contains("toc-open");
  app().classList.toggle("toc-open", open);
  $("tocHandle").setAttribute("aria-expanded", String(open));
  if (open && !was && phone.matches) pushEntry({ toc: true });
  else if (!open && was && !fromHistory) leaveEntry("toc");
}

// Phone: the sheet is one surface as tall as its contents that moves as a
// whole, so pushing it up and scrolling it are the same: a vertical drag
// anywhere on it (on the handle only while closed) moves it; up to the top
// bar it opens, further up it slides out at the top. Let go, it stays where
// it is, an upward flick opens it fully when it was closed and glides on
// otherwise, a downward flick closes it from anywhere, near the bottom it
// closes. A tap on the handle toggles it;
// sideways is the view swipe's (ui/view-swipe.js). Tablet and desktop
// hide the handle.
function initSheetDrag() {
  const panel = $("tocPanel"), handle = $("tocHandle");
  let drag = null;    // { x, y, top, moved, lastY, lastT, v } while a pointer is down

  const top = () => panel.getBoundingClientRect().top;
  // Where the sheet's top may be: closed (only the handle shows), open (just
  // below the top bar) and the highest (its last entry at the bottom edge).
  const range = () => {
    const h = window.innerHeight, style = getComputedStyle(panel);
    const open = h - parseFloat(style.minHeight);
    return { closed: h - handle.offsetHeight - parseFloat(style.paddingBottom), open, min: Math.min(open, h - panel.offsetHeight) };
  };
  const moveTo = (y, r = range()) => {
    y = Math.min(r.closed, Math.max(r.min, y));
    panel.style.transform = `translateY(${y}px)`;
    return y;
  };

  // Lets go at `v` px/ms (down positive); `fromClosed` when the drag began with the sheet closed.
  const release = (v, fromClosed) => {
    const r = range(), y = top();
    if (v > FLICK) return setTocOpen(false);
    if (fromClosed && v < -FLICK && y > r.open) return setTocOpen(true);
    if (y > r.open && v >= 0 && r.closed - y < (r.closed - r.open) * CLOSE_BELOW) return setTocOpen(false);
    markOpen(true);
    // A glide never brings the sheet further down than the open height, or than where it was let go below it.
    const floor = Math.max(r.open, y);
    let at = y, last = performance.now();
    app().classList.add("toc-dragging");
    const step = now => {
      const dt = Math.min(now - last, 50);
      last = now;
      at = Math.min(floor, Math.max(r.min, at + v * dt));
      v *= Math.pow(GLIDE_DECAY, dt);
      moveTo(at, r);
      glide = Math.abs(v) > 0.02 && at > r.min && at < floor ? requestAnimationFrame(step) : (stopGlide(), 0);
    };
    glide = requestAnimationFrame(step);
  };

  // Moves the sheet with a drag `d` to `y` at time `t`, tracking its speed.
  const follow = (d, y, t) => {
    const dt = t - d.lastT;
    if (dt > 0) d.v = 0.7 * ((y - d.lastY) / dt) + 0.3 * d.v;
    d.lastY = y; d.lastT = t;
    moveTo(d.top + y - d.y);
  };

  panel.addEventListener("pointerdown", e => {
    if (!phone.matches || e.button !== 0) return;
    if (!app().classList.contains("toc-open") && e.target !== handle) return;
    stopGlide();
    drag = { x: e.clientX, y: e.clientY, top: top(), moved: false, lastY: e.clientY, lastT: e.timeStamp, v: 0,
      fromClosed: !app().classList.contains("toc-open") };
  });
  panel.addEventListener("pointermove", e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved) {
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
      if (Math.abs(dx) > Math.abs(dy)) { drag = null; return; }   // sideways: the view swipe
      drag.moved = true;
      cancelPress();
      app().classList.add("toc-dragging");
      panel.setPointerCapture(e.pointerId);
    }
    follow(drag, e.clientY, e.timeStamp);
  });
  const onUp = e => {
    if (!drag) return;
    const { moved, v, lastT, fromClosed } = drag;
    drag = null;
    if (!moved) {
      if (e.target === handle && e.type === "pointerup") setTocOpen(!app().classList.contains("toc-open"));
      return;
    }
    app().classList.remove("toc-dragging");
    // The click that ends a drag doesn't reach an entry or a button.
    const swallow = ev => { ev.stopPropagation(); ev.preventDefault(); };
    panel.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => panel.removeEventListener("click", swallow, { capture: true }));
    release(e.type === "pointerup" && e.timeStamp - lastT < HOLD_STILL_MS ? v : 0, fromClosed);
  };
  panel.addEventListener("pointerup", onUp);
  panel.addEventListener("pointercancel", onUp);
  // Closed, a drag up from a thin strip at either screen edge in the
  // bottom third pulls the sheet up too (a flick opens it fully), so the handle needn't be hit;
  // down there it still scrolls the list, sideways it is the view swipe.
  let edge = null;   // { y, top, lastY, lastT, v, x, taken } while a finger is down in a strip
  document.addEventListener("touchstart", e => {
    edge = null;
    if (!phone.matches || e.touches.length !== 1 || app().classList.contains("toc-open") || !panel.getClientRects().length) return;
    const { clientX: x, clientY: y } = e.touches[0];
    if (y < window.innerHeight * (1 - EDGE_ZONE) || (x > EDGE_STRIP && x < window.innerWidth - EDGE_STRIP)) return;
    if (!e.target.closest(".main") || e.target.closest(".fab, .topbar")) return;
    edge = { x, y, top: 0, lastY: y, lastT: e.timeStamp, v: 0, taken: false };
  }, { passive: true });
  document.addEventListener("touchmove", e => {
    if (!edge) return;
    const { clientX: x, clientY: y } = e.touches[0];
    if (!edge.taken) {
      const dx = x - edge.x, dy = y - edge.y;
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
      if (!e.cancelable || dy > 0 || Math.abs(dx) > Math.abs(dy)) { edge = null; return; }
      stopGlide();
      edge.taken = true;
      edge.top = top();
      app().classList.add("toc-dragging");
    }
    e.preventDefault();
    follow(edge, y, e.timeStamp);
  }, { passive: false });
  const onEdgeEnd = e => {
    if (!edge?.taken) { edge = null; return; }
    const { v, lastT } = edge;
    edge = null;
    app().classList.remove("toc-dragging");
    release(e.type === "touchend" && e.timeStamp - lastT < HOLD_STILL_MS ? v : 0, true);
  };
  document.addEventListener("touchend", onEdgeEnd);
  document.addEventListener("touchcancel", onEdgeEnd);
  // A mouse wheel (a narrow desktop window) scrolls the open sheet the same way.
  panel.addEventListener("wheel", e => {
    if (!phone.matches || !app().classList.contains("toc-open")) return;
    e.preventDefault();
    stopGlide();
    const r = range();
    moveTo(Math.min(Math.max(r.open, top()), top() - e.deltaY), r);
  }, { passive: false });
  // Fewer entries (another view, a lower depth) or another window height:
  // the sheet's end doesn't lift off the bottom edge.
  const fit = () => { if (panel.style.transform && top() < range().min) moveTo(range().min); };
  new ResizeObserver(fit).observe(panel);
  window.addEventListener("resize", fit);
  phone.addEventListener("change", () => { panel.style.transform = ""; });   // the sidebar doesn't move
  // Keyboard: the handle is a button.
  handle.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setTocOpen(!app().classList.contains("toc-open")); }
  });
}

function stepDepth(delta) {
  // Clamp against the levels that actually occur, so "+" never goes dead.
  const shownDepth = Number($("tocDepth").textContent);
  updateSettings({ tocDepth: Math.max(1, shownDepth + delta) });
}

function jump(key) {
  const [noteId, index] = key.split("#");
  const noteEl = document.querySelector(`.note[data-id="${noteId}"]`);
  if (!noteEl) return;
  const section = noteEl.querySelector(`.md-section[data-section="${index}"]`);
  const target = (index !== "0" && section && section.firstElementChild) || noteEl;
  if (phone.matches) setTocOpen(false);
  target.scrollIntoView({ block: "start", behavior: phone.matches ? "auto" : "smooth" });
  flashNote(noteId);
}

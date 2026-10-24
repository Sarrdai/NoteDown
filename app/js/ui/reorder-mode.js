// Reorder mode (docs/requirements.md → "Multi-select" → "Reorder mode"; decided 2026-10-24, user request, after
// Google Keep's handles): on touch a swipe to the right in the notes — where no view lies — shows the grips,
// following the finger, and a swipe to the left hides them again instead of going to the archive (revealSwipe,
// ui/view-swipe.js → edge; decided over a button above the +). While it is on, every list item and heading of
// the open notes shows a grip at its left. A grip drags at once (no long-press first); held without moving, it
// selects its part instead. A tap on a note's text doesn't edit meanwhile. Ends with the swipe back, Esc, back
// or a view change. The desktop has no mode: the grip shows under the mouse (ui/drag-drop.js).
import { state } from "../store.js";
import { draggableAt, startDrag, startNoteDrag, startShelfDrag, moveDrag, endDrag, firstLine } from "./drag-drop.js";
import { pickAt, showPick, dragGroup, noteDragIds } from "./selection.js";
import { pushEntry, leaveEntry } from "./dom.js";

const HOLD_MS = 450;
const MOVE_TOLERANCE = 8;
const REVEAL_PX = 90;   // the finger's way that shows (or hides) the grips fully
const FLICK = 0.4;      // px/ms that finishes the swipe regardless of the way
const SETTLE_MS = 200;
const GRIPPABLE = ".note-body li[data-line], .note-body .md-section > :is(h1, h2, h3, h4, h5, h6):first-child";

const $ = id => document.getElementById(id);
let on = false;
let press = null;   // { at, x0, y0, timer, dragging, touch } while a grip is held

export const isReordering = () => on;

export function initReorderMode() {
  const list = $("list");
  list.addEventListener("pointerdown", onPointerDown);
  // On touch the grip must keep the list from scrolling: only a touchstart listener can.
  list.addEventListener("touchstart", onTouchStart, { passive: false });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && on && !document.querySelector(".dialog-scrim:not([hidden])")) setReordering(false); });
  window.addEventListener("popstate", () => { if (on && !history.state?.reorder) setReordering(false, { fromHistory: true }); });
}

/** Switches the mode; it ends on its own outside the main view. */
export function setReordering(next, { fromHistory = false } = {}) {
  next = !!next && state.view === "open";
  if (next === on) return;
  on = next;
  $("app").classList.toggle("reordering", on);
  if (on) pushEntry({ reorder: true });
  else if (!fromHistory) leaveEntry("reorder");
}

/** The sideways swipe on the notes (ui/view-swipe.js → edge) when it shows or hides the grips: to the right
 *  (dx > 0) while the mode is off, to the left while it is on; null otherwise (it switches views). The grips
 *  follow the finger (--reveal 0…1), past the full way the list gives a little, like a list at its end;
 *  let go past half the way or with a flick, the mode switches, else everything settles back. */
export function revealSwipe(dx) {
  if (state.view !== "open" || (dx > 0) === on) return null;
  const app = $("app"), showing = !on;
  const share = d => Math.min(1, Math.abs(d) / REVEAL_PX);
  app.classList.add("revealing");
  const set = (reveal, give) => { app.style.setProperty("--reveal", reveal); app.style.setProperty("--reveal-give", give + "px"); };
  return {
    move: d => set(showing ? share(d) : 1 - share(d), Math.sign(d) * Math.max(0, Math.abs(d) - REVEAL_PX) * 0.15),
    end: (d, v) => {
      const done = share(d) > 0.5 || (Math.abs(v) > FLICK && Math.sign(v) === Math.sign(d));
      app.classList.add("reveal-settle");
      set(showing === done ? 1 : 0, 0);
      setTimeout(() => {
        if (done) setReordering(showing);
        app.classList.remove("revealing", "reveal-settle");
        app.style.removeProperty("--reveal");
        app.style.removeProperty("--reveal-give");
      }, SETTLE_MS);
    },
  };
}

/** The part whose grip is at `target` and x (its ::before at the element's left), or null. With the Shelves the
 *  grip of a note's first line moves the whole note: { kind: "note", el, head } (the card) — in the arrange view
 *  the only grip besides the shelves'. */
export function gripAt(target, x) {
  const arranging = $("app").classList.contains("arranging");
  if (!on && !arranging) return null;
  // The arrange view (ui/shelf-arrange.js): a shelf's grip moves it with its notes.
  const shelf = arranging && target?.closest?.(".shelf-grip") && target.closest(".section-header");
  if (shelf) return { kind: "shelf", id: shelf.dataset.section, el: shelf, head: shelf };
  const onGrip = el => {
    const grip = getComputedStyle(el, "::before");
    if (grip.content === "none") return false;
    const left = el.getBoundingClientRect().left + parseFloat(grip.left);
    return x >= left - 8 && x <= left + parseFloat(grip.width) + 8;
  };
  const card = $("app").classList.contains("shelves") && target?.closest?.("#list .note:not(.closed)");
  const first = card && firstLine(card);
  if (first && (target === first || target.closest(GRIPPABLE + ", p") === first) && onGrip(first)) return { kind: "note", noteId: card.dataset.id, el: card, head: first };
  if (!on) return null;
  const el = target?.closest?.(GRIPPABLE);
  const at = el && draggableAt(el);
  return at && onGrip(el) ? at : null;
}

function onPointerDown(e) {
  if (e.pointerType !== "mouse" || e.button !== 0) return;
  const at = gripAt(e.target, e.clientX);
  if (!at) return;
  e.preventDefault();
  begin(at, e.clientX, e.clientY, false);
  const move = ev => track(ev.clientX, ev.clientY);
  const up = ev => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    finish(ev.type === "pointerup");
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

function onTouchStart(e) {
  if (e.touches.length !== 1) return;
  const t = e.touches[0];
  const at = gripAt(e.target, t.clientX);
  if (!at) return;
  e.preventDefault();   // no scrolling, no long-press callout, no click
  begin(at, t.clientX, t.clientY, true);
  const move = ev => { ev.preventDefault(); track(ev.touches[0].clientX, ev.touches[0].clientY); };
  const end = ev => {
    window.removeEventListener("touchmove", move);
    window.removeEventListener("touchend", end);
    window.removeEventListener("touchcancel", end);
    finish(ev.type === "touchend");
  };
  window.addEventListener("touchmove", move, { passive: false });
  window.addEventListener("touchend", end);
  window.addEventListener("touchcancel", end);
}

// Held without moving, the grip selects its part (the start of a multi-select); moved, it drags.
function begin(at, x, y, touch) {
  showPick(at.kind === "item" ? at.head : at.el);
  press = { at, x0: x, y0: y, touch, dragging: false, held: false, timer: setTimeout(() => {
    if (!press || press.dragging || at.kind === "shelf") return;   // a shelf isn't selected
    press.held = true;
    try { navigator.vibrate?.(15); } catch { /* not allowed */ }
    showPick(null);
    pickAt(at.kind === "note" ? at.el : at.head);
  }, HOLD_MS) };
}

function track(x, y) {
  if (!press) return;
  if (!press.dragging && Math.hypot(x - press.x0, y - press.y0) > MOVE_TOLERANCE) {
    clearTimeout(press.timer);
    press.dragging = true;
    showPick(null);
    if (press.at.kind === "shelf") startShelfDrag(press.at.el, press.x0, press.y0);
    else if (press.at.kind === "note") startNoteDrag(press.at.el, noteDragIds(press.at.noteId), press.x0, press.y0);
    else startDrag(press.at, press.x0, press.y0, dragGroup(press.at));
  }
  if (press.dragging) moveDrag(x, y);
}

// A short tap or click selects the part — while selecting it adds or takes it out —, as a held grip does.
function finish(commit) {
  if (!press) return;
  const { at, dragging, held, timer } = press;
  press = null;
  clearTimeout(timer);
  showPick(null);
  if (dragging) return endDrag(commit);
  if (commit && !held && at.kind !== "shelf") pickAt(at.kind === "note" ? at.el : at.head);
}

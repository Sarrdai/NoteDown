// Reorder mode (docs/requirements.md → "Multi-select" → "Reorder mode"; decided 2026-10-24, user request, after
// Google Keep's handles): a button switches it on and off; while it is on, every list item and heading of the
// open notes shows a grip at its left. A grip drags at once (no long-press first); held without moving, it
// selects its part instead. A tap on a note's text doesn't edit meanwhile. Ends with the button, Esc, back
// or a view change. Prototype variants for the button: "pill" — a small pill beside the floating sort button;
// "search" — an icon in the search field.
import { state } from "../store.js";
import { draggableAt, startDrag, moveDrag, endDrag } from "./drag-drop.js";
import { pickAt, showPick } from "./selection.js";
import { pushEntry, leaveEntry } from "./dom.js";
import { icon } from "./icons.js";

const HOLD_MS = 450;
const MOVE_TOLERANCE = 8;
const GRIPPABLE = ".note-body li[data-line], .note-body .md-section > :is(h1, h2, h3, h4, h5, h6):first-child";

const $ = id => document.getElementById(id);
let on = false;
let press = null;   // { at, x0, y0, timer, dragging, touch } while a grip is held

export const isReordering = () => on;

export function initReorderMode() {
  for (const id of ["reorderFab", "reorderBtn"]) $(id).addEventListener("click", () => setReordering(!on));
  renderButtons();
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
  renderButtons();
}

function renderButtons() {
  const label = on ? "Done reordering" : "Reorder: show the handles";
  $("reorderFab").innerHTML = on ? icon("check") + `<span class="sort-fab-label">Done</span>` : icon("grip");
  $("reorderBtn").innerHTML = icon(on ? "check" : "grip");
  for (const id of ["reorderFab", "reorderBtn"]) {
    $(id).setAttribute("aria-pressed", String(on));
    $(id).setAttribute("aria-label", label);
    $(id).title = label;
  }
}

/** The part whose grip is at `target` and x (its ::before at the element's left), or null. */
export function gripAt(target, x) {
  if (!on) return null;
  const el = target?.closest?.(GRIPPABLE);
  const at = el && draggableAt(el);
  if (!at) return null;
  const grip = getComputedStyle(el, "::before");
  const left = el.getBoundingClientRect().left + parseFloat(grip.left);
  return x >= left - 8 && x <= left + parseFloat(grip.width) + 8 ? at : null;
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
    finish(ev.type === "pointerup", true);
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
    finish(ev.type === "touchend", false);
  };
  window.addEventListener("touchmove", move, { passive: false });
  window.addEventListener("touchend", end);
  window.addEventListener("touchcancel", end);
}

// Held without moving, the grip selects its part (the start of a multi-select); moved, it drags.
function begin(at, x, y, touch) {
  showPick(at.kind === "section" ? at.el : at.head);
  press = { at, x0: x, y0: y, touch, dragging: false, held: false, timer: setTimeout(() => {
    if (!press || press.dragging) return;
    press.held = true;
    try { navigator.vibrate?.(15); } catch { /* not allowed */ }
    showPick(null);
    pickAt(at.head);
  }, HOLD_MS) };
}

function track(x, y) {
  if (!press) return;
  if (!press.dragging && Math.hypot(x - press.x0, y - press.y0) > MOVE_TOLERANCE) {
    clearTimeout(press.timer);
    press.dragging = true;
    showPick(null);
    startDrag(press.at, press.x0, press.y0);
  }
  if (press.dragging) moveDrag(x, y);
}

// A click with the mouse selects the part, as the desktop's hover grip does; a short tap on touch does nothing.
function finish(commit, mouse) {
  if (!press) return;
  const { at, dragging, held, timer } = press;
  press = null;
  clearTimeout(timer);
  showPick(null);
  if (dragging) return endDrag(commit);
  if (commit && mouse && !held) pickAt(at.head);
}

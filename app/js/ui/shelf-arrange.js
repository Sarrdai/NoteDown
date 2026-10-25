// The arrange view of the Shelves (docs/requirements.md → "Sorting and search" → "Shelves"; decided 2026-10-24,
// user request, over the arrange dialog: one way to order notes, the list itself): the cards shrink to their
// first lines, the pile on top, every shelf shows — also one without notes — and "+ Shelf" ends the list. A
// note's grip puts it onto a shelf, between notes or back onto the pile; a shelf's grip moves it with its
// notes; its name is edited in place, × removes it (ui/note-list.js → shelfHeader). Every change applies at
// once, with Undo. "Done" (in the + button's corner), Esc, back or a view change end it. Opened by the pile
// header's button or the sort menu ("Arrange shelves"). The drags are ui/drag-drop.js's.
import { state } from "../store.js";
import { pushEntry, leaveEntry } from "./dom.js";
import { icon } from "./icons.js";

const $ = id => document.getElementById(id);
let on = false;
let opts = null;   // { canArrange(), render() }

export const isArranging = () => on;

export function initShelfArrange(options) {
  opts = options;
  $("arrangeDone").innerHTML = icon("check") + `<span class="sort-fab-label">Done</span>`;
  $("arrangeDone").addEventListener("click", () => setArranging(false));
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && on && !e.target.closest("input") && !document.querySelector(".dialog-scrim:not([hidden])")) setArranging(false);
  });
  window.addEventListener("popstate", () => { if (on && !history.state?.arrange) setArranging(false, { fromHistory: true }); });
}

/** Opens or ends the arrange view; it only opens on a view sorted by Shelves. */
export function setArranging(next, { fromHistory = false } = {}) {
  next = !!next && opts.canArrange();
  if (next === on) return;
  on = next;
  $("app").classList.toggle("arranging", on);
  if (on) { pushEntry({ arrange: true }); window.scrollTo(0, 0); }
  else if (!fromHistory) leaveEntry("arrange");
  opts.render();
}

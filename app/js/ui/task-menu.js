// The states of a task (docs/requirements.md → "Task states and progress"):
// a tap on its box ticks it as before, a long-press (desktop: right-click)
// opens a small menu with all four states. Used on rendered notes
// (ui/note-list.js) and on the editor's checkboxes (ui/live-preview.js).
import { openMenu } from "./menu.js";
import { gripAt } from "./reorder-mode.js";

const HOLD_MS = 450;
const MOVE_TOLERANCE = 10;
const LABELS = { open: "Open", doing: "In progress", done: "Done", cancelled: "Cancelled" };

/** A box's state as rendered (core/markdown.js → taskBox). */
export const boxState = box => box.dataset.state || (box.checked ? "done" : "open");

/**
 * Makes a long-press or right-click on `box` open the state menu; `pick(state)`
 * sets the chosen one. The click that ends a long-press doesn't tick the box.
 */
export function holdForStates(box, pick) {
  let press = null;   // { x, y, timer }
  let held = false;
  const open = () => {
    held = true;
    const current = boxState(box);
    openMenu(box, Object.entries(LABELS).map(([state, label]) => ({
      label, checked: state === current, onSelect: () => { if (state !== current) pick(state); },
    })));
  };
  const cancel = () => { if (press) clearTimeout(press.timer); press = null; };
  // While notes are selected, a tap or hold on a box belongs to the selection; on the reorder mode's grip
  // beside it (the box's enlarged target reaches it) to the grip (ui/reorder-mode.js).
  const selecting = () => !!box.closest(".app.selecting");
  box.addEventListener("pointerdown", e => {
    held = false;
    if (e.button !== 0 || selecting() || gripAt(box, e.clientX)) return;
    press = { x: e.clientX, y: e.clientY, timer: setTimeout(() => {
      press = null;
      try { navigator.vibrate?.(15); } catch { /* not allowed */ }
      open();
    }, HOLD_MS) };
  });
  box.addEventListener("pointermove", e => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE) cancel();
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) box.addEventListener(type, cancel);
  // Right-click, and the touch long-press's own context menu (whichever comes first opens it).
  box.addEventListener("contextmenu", e => {
    e.preventDefault();
    e.stopPropagation();
    if (held || selecting() || gripAt(box, e.clientX)) return;
    cancel();
    open();
  });
  box.addEventListener("click", e => {
    if (!held) return;
    held = false;
    e.preventDefault();
    e.stopPropagation();
  });
}

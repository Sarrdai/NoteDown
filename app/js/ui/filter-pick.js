// How the People and Labels tabs pick several entries at once. Prototype
// variants (⋮ → "Prototype: Picking several"):
//   toggle (A) — a tap adds or removes the entry; the phone sheet stays open.
//   check  (B) — a tap shows only this entry (closes the phone sheet); the
//                checkbox at the row's end adds or removes it.
//   hold   (C) — a tap shows only this entry; a long-press (desktop:
//                right-click) adds or removes it.
// Ctrl/Cmd+click adds or removes in every variant (desktop).
import { state } from "../store.js";

const HOLD_MS = 450;
const MOVE_TOLERANCE = 10;

export const filterMode = () => state.settings.filterUi;

/** The checkbox at a row's end (variant B); `on` = picked. */
export function checkHtml(on) {
  return filterMode() === "check" ? `<span class="pick-check${on ? " on" : ""}" role="checkbox" aria-checked="${on}" aria-label="Add to the filter"></span>` : "";
}

/** Wires taps on the entries of `list` (matching `selector`):
 *  `single(el)` shows only this entry, `toggle(el)` adds or removes it,
 *  `menu(el)` (optional) is the long-press menu where no variant claims the long-press.
 *  Each returns nothing; `closes(true|false)` is told whether the phone sheet may close. */
export function wirePick(list, { selector, single, toggle, menu, isAll = () => false, closes }) {
  let press = null;
  let swallowClick = false;
  const holds = el => filterMode() === "hold" ? !isAll(el) : !!menu && menu.accepts(el);
  const hold = el => { if (filterMode() === "hold") { toggle(el); closes(false); } else menu.open(el); };
  const cancel = () => { if (press) { clearTimeout(press.timer); press = null; } };

  list.addEventListener("pointerdown", e => {
    swallowClick = false;
    const el = e.target.closest(selector);
    if (!el || e.button !== 0 || !holds(el)) return;
    press = { x: e.clientX, y: e.clientY, timer: setTimeout(() => {
      press = null;
      swallowClick = true; // the click that follows the release
      try { navigator.vibrate?.(15); } catch { /* not allowed */ }
      hold(el);
    }, HOLD_MS) };
  });
  list.addEventListener("pointermove", e => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE) cancel();
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) list.addEventListener(type, cancel);
  list.addEventListener("contextmenu", e => {
    const el = e.target.closest(selector);
    if (!el) return;
    e.preventDefault();
    if (!swallowClick && holds(el)) hold(el);
  });
  list.addEventListener("click", e => {
    const el = e.target.closest(selector);
    if (!el) return;
    if (swallowClick) { swallowClick = false; return; }
    const adds = !isAll(el) && (filterMode() === "toggle" || e.ctrlKey || e.metaKey || e.target.closest(".pick-check"));
    if (adds) { toggle(el); closes(false); }
    else { single(el); closes(filterMode() !== "toggle"); }
  });
}

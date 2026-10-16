// Picking several entries in the People and Labels tabs (decided 2026-10-16,
// like multi-select on notes): a tap shows only this entry (and closes the
// phone sheet); a long-press — desktop: right-click or Ctrl/Cmd+click —
// starts picking several: the tab shows a bar with × and the count, every
// entry a checkbox, and a tap then adds or removes an entry. ×, the back
// key, Esc or taking out the last entry leave it; the picked entries stay.
import { state, setUi } from "../store.js";
import { pushEntry, leaveEntry } from "./dom.js";
import { icon } from "./icons.js";

const HOLD_MS = 450;
const MOVE_TOLERANCE = 10;

const picking = tab => state.picking === tab;

/** Starts (tab) or ends (null) picking several; `fromHistory` when the back key ended it. */
export function setPicking(tab, { fromHistory = false } = {}) {
  if (state.picking === tab) return;
  const was = state.picking;
  setUi({ picking: tab });
  if (tab && !was) pushEntry({ picking: true });
  if (!tab && was && !fromHistory) leaveEntry("picking");
}

window.addEventListener("popstate", () => { if (state.picking && !history.state?.picking) setPicking(null, { fromHistory: true }); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && state.picking) setPicking(null); });

/** The checkbox at a row's end while its tab picks several; `on` = picked. */
export function checkHtml(tab, on) {
  return picking(tab) ? `<span class="pick-check${on ? " on" : ""}" aria-hidden="true"></span>` : "";
}

/** The bar above a tab's entries while it picks several: × and the count; null otherwise. */
export function pickBar(tab, count) {
  if (!picking(tab)) return null;
  const bar = document.createElement("div");
  bar.className = "pick-bar";
  bar.innerHTML = `<button class="icon-btn small" type="button" aria-label="Stop picking several">${icon("close")}</button><span aria-live="polite"></span>`;
  bar.lastChild.textContent = `${count} selected`;
  bar.firstChild.addEventListener("click", () => setPicking(null));
  return bar;
}

/** Wires the entries of `list` (matching `selector`) of tab `tab`:
 *  `single(el)` shows only this entry, `toggle(el)` adds or removes it,
 *  `picked(el)` says whether it is picked now, `count()` how many are;
 *  `closes(true)` lets the phone sheet close after a single pick. */
export function wirePick(list, { tab, selector, single, toggle, picked, count, isAll = () => false, closes }) {
  let press = null;
  let swallowClick = false;
  const cancel = () => { if (press) { clearTimeout(press.timer); press = null; } };
  const settle = () => { if (picking(tab) && !count()) setPicking(null); };
  // A long-press starts picking with this entry added (kept, if it was the one shown); while picking it toggles.
  const hold = el => {
    if (isAll(el)) return;
    if (!picking(tab)) { setPicking(tab); if (!picked(el)) toggle(el); }
    else toggle(el);
    settle();
  };

  list.addEventListener("pointerdown", e => {
    swallowClick = false;
    const el = e.target.closest(selector);
    if (!el || e.button !== 0 || isAll(el)) return;
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
    if (!swallowClick) hold(el);
  });
  list.addEventListener("click", e => {
    const el = e.target.closest(selector);
    if (!el) return;
    if (swallowClick) { swallowClick = false; return; }
    if (e.ctrlKey || e.metaKey) return hold(el);
    if (!picking(tab)) { single(el); return closes(true); }
    // While picking, "All notes" clears the filter and ends it.
    if (isAll(el)) { single(el); return setPicking(null); }
    toggle(el);
    settle();
  });
}

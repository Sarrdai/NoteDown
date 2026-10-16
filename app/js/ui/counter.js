// Taps on a counter (core/counter.js), in the rendered note and in the
// editor's live preview: a step button changes the number. Prototype
// variants (settings.counterStyle): "stepper" (A) and "row" (B) show the
// buttons; "menu" (C) shows only the number, which opens a menu of the steps.
import { state } from "../store.js";
import { openMenu } from "./menu.js";

/** Handles a tap inside a counter; `apply(step)` changes its number. → true when the tap was a counter's. */
export function counterClick(e, apply) {
  const c = e.target.closest(".counter");
  if (!c) return false;
  e.preventDefault();
  const b = e.target.closest("button");
  if (!b || b.disabled) return true;
  if (b.dataset.step) apply(b.dataset.step);
  else if (state.settings.counterStyle === "menu") {
    openMenu(b, [{ section: "Counter" }, ...c.dataset.steps.split(" ").map(s => ({ label: s.replace("-", "−"), onSelect: () => apply(s) }))]);
  }
  return true;
}

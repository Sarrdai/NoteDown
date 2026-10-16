// Taps on a counter (core/counter.js), in the rendered note and in the
// editor's live preview: a step button changes the number. Prototype
// variants (settings.counterStyle): "stepper" (A) and "row" (B) show the
// buttons in the text; "pop" (D) and "card" (E) show only the number, and a
// tap on it opens the buttons floating over the page — D around the number
// itself, E as a card in the middle with the line's text.
import { state } from "../store.js";
import { addStep } from "../core/counter.js";

const FLOATING = ["pop", "card"];
let open = null;   // { scrim, pop, value, apply }

/** Handles a tap inside a counter; `apply(step)` changes its number. → true when the tap was a counter's. */
export function counterClick(e, apply) {
  const c = e.target.closest(".counter");
  if (!c) return false;
  e.preventDefault();
  const b = e.target.closest("button");
  if (!b || b.disabled) return true;
  if (b.dataset.step) apply(b.dataset.step);
  else if (FLOATING.includes(state.settings.counterStyle)) openPop(c, apply);
  return true;
}

function openPop(counter, apply) {
  closePop();
  const style = state.settings.counterStyle;
  const value = counter.querySelector(".counter-value").textContent;
  const steps = counter.dataset.steps.split(" ");
  const scrim = document.createElement("div");
  scrim.className = `counter-scrim keep-editing ${style}`;
  const pop = document.createElement("div");
  pop.className = `counter-pop keep-editing ${style}`;
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Counter");
  const button = s => `<button type="button" class="counter-step${s.startsWith("-") ? " minus" : ""}" data-step="${s}" aria-label="${s.startsWith("-") ? "Minus" : "Plus"} ${s.slice(1)}">${s.replace("-", "−")}</button>`;
  pop.innerHTML = (style === "card" ? `<div class="counter-pop-label"></div>` : "") +
    `<div class="counter-pop-row">${steps.filter(s => s.startsWith("-")).map(button).join("")}` +
    `<span class="counter-pop-value"></span>${steps.filter(s => !s.startsWith("-")).map(button).join("")}</div>`;
  pop.querySelector(".counter-pop-value").textContent = value;
  if (style === "card") pop.querySelector(".counter-pop-label").textContent = lineLabel(counter);
  // Buttons must not take focus, or the editor (and the keyboard) would close.
  pop.addEventListener("pointerdown", e => { if (e.target.closest("button")) e.preventDefault(); });
  pop.addEventListener("click", e => {
    const b = e.target.closest("button[data-step]");
    if (!b) return;
    open.value = addStep(open.value, b.dataset.step);
    pop.querySelector(".counter-pop-value").textContent = open.value;
    apply(b.dataset.step);
  });
  scrim.addEventListener("pointerdown", e => e.preventDefault());
  scrim.addEventListener("click", closePop);
  document.body.append(scrim, pop);
  open = { scrim, pop, value, apply };
  if (style === "pop") placeOver(pop, counter.querySelector(".counter-value"));
  requestAnimationFrame(() => pop.classList.add("shown"));
}

// D: the floating number lies exactly over the tapped one, the steps to its sides.
function placeOver(pop, chip) {
  const r = chip.getBoundingClientRect();
  // Layout sizes, not the bounding box: the pop starts scaled down.
  const v = pop.querySelector(".counter-pop-value");
  const left = r.left + r.width / 2 - (v.offsetLeft + v.offsetWidth / 2);
  pop.style.left = Math.max(8, Math.min(left, window.innerWidth - pop.offsetWidth - 8)) + "px";
  pop.style.top = Math.max(8, r.top + r.height / 2 - pop.offsetHeight / 2) + "px";
}

// The text of the counter's line before it, e.g. "P-2041 Website relaunch".
function lineLabel(counter) {
  const block = counter.closest("li, p, h1, h2, h3, h4, h5, h6, td, .cm-line");
  if (!block) return "";
  const range = document.createRange();
  range.setStart(block, 0);
  range.setEndBefore(counter);
  return range.toString().replace(/^[•\s]+/, "").replace(/[\s:]+$/, "");
}

export function closePop() {
  if (!open) return;
  open.scrim.remove();
  open.pop.remove();
  open = null;
}

document.addEventListener("keydown", e => { if (e.key === "Escape") closePop(); });
window.addEventListener("resize", closePop);

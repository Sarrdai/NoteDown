// Taps on a counter (core/counter.js), in the rendered note and in the
// editor's live preview: the number pops up its step buttons around itself,
// floating over the text; each tap on one changes the number. A tap beside
// them or Esc closes them.
import { addStep } from "../core/counter.js";

let open = null;   // { scrim, pop, value }

/** Handles a tap on a counter; `apply(step)` changes its number. → true when the tap was a counter's. */
export function counterClick(e, apply) {
  const c = e.target.closest(".counter");
  if (!c) return false;
  e.preventDefault();
  if (!c.disabled) openPop(c, apply);
  return true;
}

function openPop(counter, apply) {
  closePop();
  const steps = counter.dataset.steps.split(" ");
  const scrim = document.createElement("div");
  scrim.className = "counter-scrim keep-editing";
  const pop = document.createElement("div");
  pop.className = "counter-pop keep-editing";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Counter");
  const button = s => `<button type="button" class="counter-step${s.startsWith("-") ? " minus" : ""}" data-step="${s}" aria-label="${s.startsWith("-") ? "Minus" : "Plus"} ${s.slice(1)}">${s.replace("-", "−")}</button>`;
  pop.innerHTML = steps.filter(s => s.startsWith("-")).map(button).join("") +
    `<span class="counter-pop-value"></span>` + steps.filter(s => !s.startsWith("-")).map(button).join("");
  open = { scrim, pop, value: counter.textContent };
  pop.querySelector(".counter-pop-value").textContent = open.value;
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
  placeOver(pop, counter);
  requestAnimationFrame(() => pop.classList.add("shown"));
}

// The floating number lies exactly over the tapped one, the steps to its sides.
function placeOver(pop, chip) {
  const r = chip.getBoundingClientRect();
  // Layout sizes, not the bounding box: the pop starts scaled down.
  const v = pop.querySelector(".counter-pop-value");
  const left = r.left + r.width / 2 - (v.offsetLeft + v.offsetWidth / 2);
  pop.style.left = Math.max(8, Math.min(left, window.innerWidth - pop.offsetWidth - 8)) + "px";
  pop.style.top = Math.max(8, r.top + r.height / 2 - pop.offsetHeight / 2) + "px";
}

export function closePop() {
  if (!open) return;
  open.scrim.remove();
  open.pop.remove();
  open = null;
}

document.addEventListener("keydown", e => { if (e.key === "Escape") closePop(); });
window.addEventListener("resize", closePop);

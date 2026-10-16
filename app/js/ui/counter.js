// Taps on a counter (core/counter.js), in the rendered note and in the
// editor's live preview: the number pops up its step buttons around itself,
// floating over the text. The taps add up as a pending change ("36 + 8") that
// is written into the number only when they close — a tap beside them, Esc or
// the back key (they sit on their own history entry). A tap on the number in
// the pop-up types an amount of one's own. A time or hours counter with a
// stopwatch starts and stops it (written at once); while it runs, the chip
// counts the time live. A running stopwatch can also be discarded: it stops
// without adding the run (forgotten to stop). The running ones show above
// the list as well (ui/watch-bar.js), whose chips open the same pop-up.
//
// Prototype variants (settings.watchUi, ?watch=): where Start / Stop and the
// amount input sit — "row" (A): a Start / Stop pill at the end of the steps,
// the number turns into the input; "rows" (B): a second row with Start / Stop
// and an input that is always there; "chip" (C): Start / Stop is a part of the
// chip itself, one tap without the pop-up.
import { sumSteps, pendingText, parseAmount, isZero, elapsedMs, clock } from "../core/counter.js";
import { state } from "../store.js";
import { icon } from "./icons.js";
import { pushEntry, leaveEntry } from "./dom.js";

let open = null;   // { scrim, pop, chip, value, delta, change }

const variant = () => state.settings.watchUi;
const watchOf = chip => (chip.dataset.watch === undefined ? null : { round: Number(chip.dataset.watch), since: chip.dataset.since || null });

/**
 * Handles a tap on a counter; `change({ step, watch })` changes it in the
 * source: `step` added to the value (once, the sum, when the pop-up closes),
 * `watch` "start" | "stop". → true when the tap was a counter's.
 */
export function counterClick(e, change) {
  const c = e.target.closest(".counter");
  if (!c) return false;
  e.preventDefault();
  if (c.disabled) return true;
  const w = watchOf(c);
  if (w && variant() === "chip" && e.target.closest(".counter-watch")) change({ watch: w.since ? "stop" : "start" });
  else openPop(c, change);
  return true;
}

/** Opens the pop-up for another element that carries a counter's data (the running stopwatches above the list), with Start / Stop in every variant. */
export function openCounterPop(chip, change) {
  openPop(chip, change, true);
}

function openPop(chip, change, withWatch = false) {
  closePop();
  const steps = chip.dataset.steps ? chip.dataset.steps.split(" ") : [];
  const watch = watchOf(chip);
  const scrim = document.createElement("div");
  scrim.className = "counter-scrim keep-editing";
  const pop = document.createElement("div");
  pop.className = `counter-pop keep-editing pop-${variant()}`;
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Counter");
  const button = s => `<button type="button" class="counter-step${s.startsWith("-") ? " minus" : ""}" data-step="${s}" aria-label="${s.startsWith("-") ? "Minus" : "Plus"} ${s.slice(1)}">${s.replace("-", "−")}</button>`;
  const watchBtn = (watch && (variant() !== "chip" || withWatch)
    ? `<button type="button" class="counter-watch-btn${watch.since ? " running" : ""}" data-watch="${watch.since ? "stop" : "start"}">`
      + `${icon(watch.since ? "stop" : "play")}<span>${watch.since ? clock(elapsedMs(watch, Date.now())) : "Start"}</span></button>`
    : "") + (watch && watch.since
    ? `<button type="button" class="counter-discard" data-watch="discard" aria-label="Discard the run" title="Discard the run (adds nothing)">${icon("close")}</button>`
    : "");
  const row = steps.filter(s => s.startsWith("-")).map(button).join("")
    + `<button type="button" class="counter-pop-value" aria-label="Type an amount"></button>`
    + steps.filter(s => !s.startsWith("-")).map(button).join("");
  const kind = chip.dataset.kind;
  const input = `<input class="counter-input" inputmode="decimal" enterkeyhint="done" autocomplete="off" placeholder="${kind === "time" ? "+0:40" : "+1,5"}" aria-label="Amount to add${kind === "time" ? " (h:mm or minutes)" : ""}">`;
  pop.innerHTML = variant() === "rows"
    ? `<div class="counter-row">${row}</div><div class="counter-row second">${watchBtn}${input}</div>`
    : `<div class="counter-row">${row}${watchBtn}</div>`;
  const value = chip.dataset.value || chip.querySelector(".counter-value")?.textContent || chip.textContent;
  open = { scrim, pop, chip, value, delta: "+0", change, kind };
  showValue();
  // Buttons must not take focus, or the editor (and the keyboard) would close.
  pop.addEventListener("pointerdown", e => { if (e.target.closest("button")) e.preventDefault(); });
  pop.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.step) {
      open.delta = sumSteps(open.delta, b.dataset.step);
      showValue();
    } else if (b.dataset.watch) {
      // Start / Stop is written at once, together with the pending taps.
      const { delta, change: apply } = open;
      closePop({ apply: false });
      apply({ step: isZero(delta) ? null : delta, watch: b.dataset.watch });
    } else if (b.classList.contains("counter-pop-value") && variant() !== "rows") {
      typeAmount(b);
    }
  });
  pop.addEventListener("keydown", e => {
    const field = e.target.closest(".counter-input");
    if (field && e.key === "Enter") { e.preventDefault(); addTyped(field); }
  });
  scrim.addEventListener("pointerdown", e => e.preventDefault());
  scrim.addEventListener("click", () => closePop());
  document.body.append(scrim, pop);
  place();
  pushEntry({ counter: true });
  requestAnimationFrame(() => pop.classList.add("shown"));
}

function showValue() {
  open.pop.querySelector(".counter-pop-value").textContent = pendingText(open.value, open.delta);
  place();
}

// A or C: the number turns into the input; Enter adds the amount and turns it back.
function typeAmount(valueBtn) {
  const field = Object.assign(document.createElement("input"), {
    className: "counter-input", inputMode: "decimal", enterKeyHint: "done", autocomplete: "off",
    placeholder: open.kind === "time" ? "+0:40" : "+1,5",
  });
  field.setAttribute("aria-label", "Amount to add" + (open.kind === "time" ? " (h:mm or minutes)" : ""));
  valueBtn.replaceWith(field);
  field.addEventListener("blur", () => { if (open && field.isConnected) { field.replaceWith(valueBtn); showValue(); } });
  place();
  field.focus();
}

function addTyped(field) {
  const step = parseAmount(field.value, open.kind);
  if (!step) { field.classList.add("invalid"); return; }
  open.delta = sumSteps(open.delta, step);
  field.value = "";
  field.classList.remove("invalid");
  if (variant() === "rows") showValue();
  else field.blur();
}

// The floating number lies exactly over the tapped one, the steps to its sides.
function place() {
  const { pop, chip } = open;
  const r = chip.getBoundingClientRect();
  // Layout sizes, not the bounding box: the pop starts scaled down.
  const v = pop.querySelector(".counter-pop-value, .counter-row .counter-input");
  const row = v.parentElement;
  const left = r.left + r.width / 2 - (row.offsetLeft + v.offsetLeft + v.offsetWidth / 2);
  pop.style.left = Math.max(8, Math.min(left, window.innerWidth - pop.offsetWidth - 8)) + "px";
  pop.style.top = Math.max(8, r.top + r.height / 2 - (row.offsetTop + row.offsetHeight / 2)) + "px";
}

export function closePop({ fromHistory = false, apply = true } = {}) {
  if (!open) return;
  const { scrim, pop, delta, change } = open;
  // An amount typed but not yet confirmed counts too.
  const field = pop.querySelector(".counter-input");
  const typed = field && field.value.trim() && parseAmount(field.value, open.kind);
  scrim.remove();
  pop.remove();
  open = null;
  const sum = typed ? sumSteps(delta, typed) : delta;
  if (apply && !isZero(sum)) change({ step: sum });
  if (!fromHistory) leaveEntry("counter");
}

// The running stopwatches count on screen, every second.
function tick() {
  const now = Date.now();
  for (const el of document.querySelectorAll("[data-since]")) {
    const text = clock(elapsedMs(watchOf(el), now));
    for (const c of el.querySelectorAll(".counter-clock")) c.textContent = text;
  }
  const pill = open && open.pop.querySelector(".counter-watch-btn.running span");
  if (pill) pill.textContent = clock(elapsedMs(watchOf(open.chip), now));
}
setInterval(tick, 1000);

/** Fills the chips' stopwatch parts (after rendering): an icon, while running the time; in variant C Start / Stop. */
export function fillWatches(root) {
  for (const w of root.querySelectorAll(".counter-watch")) {
    const chip = w.closest(".counter");
    chip.classList.toggle("watch-zone", variant() === "chip");
    const running = chip.dataset.since !== undefined;
    w.innerHTML = (running ? icon(variant() === "chip" ? "stop" : "stopwatch") : icon(variant() === "chip" ? "play" : "stopwatch"))
      + (running ? `<span class="counter-clock">${clock(elapsedMs(watchOf(chip), Date.now()))}</span>` : "");
  }
}

// Esc closes only the buttons, not the edit around them (capture: before the editor).
document.addEventListener("keydown", e => {
  if (e.key !== "Escape" || !open) return;
  e.preventDefault();
  e.stopPropagation();
  closePop();
}, true);
window.addEventListener("resize", () => { if (!document.activeElement?.classList.contains("counter-input")) closePop(); });
window.addEventListener("popstate", () => { if (open && !history.state?.counter) closePop({ fromHistory: true }); });

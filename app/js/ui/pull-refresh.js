// Pull to refresh (phone and tablet, touch only): pulling the list down from
// its top starts a sync the user asked for. A round indicator follows the
// finger below the top bar, turns to the accent color once letting go would
// sync, and spins until the round is over (docs/interaction-concept.md →
// "Input"). Desktop has no touch, so no gesture.
import { icon } from "./icons.js";

const TRIGGER = 64;       // px of (damped) pull that syncs on release
const MAX = 96;
const MIN_SPIN_MS = 600;  // a round without changes still shows a turn

/** `canPull(target)`: whether a touch on `target` may start a pull now;
 *  `onRefresh()`: the sync, a promise that resolves when it is over. */
export function initPullRefresh({ canPull, onRefresh }) {
  const el = document.getElementById("pullIndicator");
  el.innerHTML = icon("refresh");
  let start = null, pull = 0, busy = false;

  const place = dist => {
    el.style.transform = `translate(-50%, ${dist - 48}px) rotate(${dist * 4}deg)`;
    el.style.opacity = Math.min(1, dist / TRIGGER);
    el.classList.toggle("ready", dist >= TRIGGER);
  };
  const hide = () => {
    el.classList.remove("pulling", "ready", "spinning");
    el.style.transform = "";
    el.style.opacity = "";
  };

  document.addEventListener("touchstart", e => {
    start = null;
    if (busy || e.touches.length !== 1 || window.scrollY > 0 || !canPull(e.target)) return;
    start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    pull = 0;
    const list = document.getElementById("list").getBoundingClientRect();
    el.style.left = list.left + list.width / 2 + "px";   // over the list, beside a docked contents panel
  }, { passive: true });

  document.addEventListener("touchmove", e => {
    if (!start) return;
    const dy = e.touches[0].clientY - start.y, dx = e.touches[0].clientX - start.x;
    // Only a downward, mostly vertical move at the top is a pull; the browser
    // keeps everything else (and its own pull to reload is held back).
    if ((!pull && (dy <= 0 || Math.abs(dx) > dy)) || !canPull(e.target)) { start = null; if (pull) hide(); return; }
    if (e.cancelable) e.preventDefault();
    pull = Math.min(MAX, dy * 0.5);
    el.classList.add("pulling");
    place(pull);
  }, { passive: false });

  const end = async () => {
    if (!start) return;
    start = null;
    if (pull < TRIGGER) return hide();
    busy = true;
    el.classList.remove("pulling");
    el.classList.add("spinning");
    place(TRIGGER);
    await Promise.all([onRefresh(), new Promise(resolve => setTimeout(resolve, MIN_SPIN_MS))]);
    hide();
    busy = false;
  };
  document.addEventListener("touchend", end);
  document.addEventListener("touchcancel", () => { start = null; if (!busy) hide(); });
}

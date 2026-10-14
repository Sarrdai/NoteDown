// Swipe between the notes and the archive (phone and tablet, touch only):
// the archive lies to the right of the notes, so swiping the list to the
// left opens the archive and swiping it to the right goes back. The list
// follows the finger; past a third of the width (or with a flick) it slides
// out and the other view slides in, otherwise it springs back. Beyond either
// end it only gives a little (docs/interaction-concept.md → "Input").
// Desktop has no touch, so no gesture; the view button switches there.

const LOCK = 10;          // px before the direction is decided
const COMMIT = 1 / 3;     // share of the width that switches on release
const FLICK = 0.5;        // px/ms that switches regardless of the distance
const EDGE_GIVE = 0.25;   // how much an impossible swipe follows the finger
const SLIDE_MS = 180;

const ORDER = ["open", "closed"];

/** `canSwipe(target)`: whether a touch on `target` may start a swipe now;
 *  `view()`: the current view; `setView(view)`: switches to another view. */
export function initViewSwipe({ canSwipe, view, setView }) {
  const main = document.querySelector(".main");
  let g = null;   // { x, y, t, dx, horizontal, lastX, lastT, v } while a finger is down
  let busy = false;

  const shift = (x, ms = 0) => {
    main.style.setProperty("--swipe-x", x + "px");
    main.style.setProperty("--swipe-ms", ms + "ms");
  };
  const reset = () => {
    main.classList.remove("swiping");
    main.style.removeProperty("--swipe-x");
    main.style.removeProperty("--swipe-ms");
  };
  // Resolves after a transition of `ms`, also if no transitionend comes.
  const settle = ms => new Promise(resolve => setTimeout(resolve, ms + 30));

  document.addEventListener("touchstart", e => {
    g = null;
    if (busy || e.touches.length !== 1 || !canSwipe(e.target) || inScroller(e.target)) return;
    const { clientX: x, clientY: y } = e.touches[0];
    g = { x, y, dx: 0, horizontal: null, lastX: x, lastT: e.timeStamp, v: 0 };
  }, { passive: true });

  document.addEventListener("touchmove", e => {
    if (!g) return;
    const { clientX: x, clientY: y } = e.touches[0];
    const dx = x - g.x, dy = y - g.y;
    if (g.horizontal === null) {
      if (Math.hypot(dx, dy) < LOCK) return;
      g.horizontal = Math.abs(dx) > Math.abs(dy) * 1.2;
      if (!g.horizontal) { g = null; return; }     // a scroll: the browser keeps it
      main.classList.add("swiping");
    }
    if (e.cancelable) e.preventDefault();
    const dt = e.timeStamp - g.lastT;
    if (dt > 0) g.v = 0.7 * ((x - g.lastX) / dt) + 0.3 * g.v;
    g.lastX = x; g.lastT = e.timeStamp;
    g.dx = target(dx) ? dx : dx * EDGE_GIVE;
    shift(g.dx);
  }, { passive: false });

  // The view a swipe by `dx` leads to, or null at either end.
  const target = dx => {
    const i = ORDER.indexOf(view()) + (dx < 0 ? 1 : -1);
    return ORDER[i] ?? null;
  };

  document.addEventListener("touchend", async () => {
    if (!g || !g.horizontal) { g = null; return; }
    const { dx, v } = g;
    g = null;
    const next = target(dx);
    const width = main.clientWidth;
    const go = next && (Math.abs(dx) > width * COMMIT || (Math.abs(v) > FLICK && Math.sign(v) === Math.sign(dx)));
    busy = true;
    if (!go) {
      shift(0, SLIDE_MS);
      await settle(SLIDE_MS);
    } else {
      const dir = Math.sign(dx);
      shift(dir * width, SLIDE_MS);
      await settle(SLIDE_MS);
      setView(next);
      shift(-dir * width);              // the new view enters from the other side
      main.getBoundingClientRect();
      shift(0, SLIDE_MS);
      await settle(SLIDE_MS);
    }
    reset();
    busy = false;
  });
  document.addEventListener("touchcancel", () => {
    if (g?.horizontal) { shift(0, SLIDE_MS); settle(SLIDE_MS).then(reset); }
    g = null;
  });
}

// A touch inside something that scrolls sideways itself (a wide table or
// code block) scrolls that instead.
function inScroller(el) {
  for (; el && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true;
  }
  return false;
}

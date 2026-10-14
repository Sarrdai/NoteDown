// Swipe between the notes and the archive (phone and tablet, touch only):
// the archive lies to the right of the notes. Like a pager, the list follows
// the finger anywhere on it (and on the contents) and the other view moves in
// beside it; let go past half the width (or with a flick) and it snaps onto
// the other view, otherwise back. Beyond either end it only gives a little.
// The top bar and the contents stay in place; they are redrawn once the view
// has switched (docs/interaction-concept.md → "Input").
// Desktop has no touch, so no gesture; the view button switches there.

const SLOP = 8;           // px before the direction is decided
const COMMIT = 1 / 2;     // share of the width that switches on release
const FLICK = 0.4;        // px/ms that switches regardless of the distance
const EDGE_GIVE = 0.25;   // how much an impossible swipe follows the finger
const HOLD_MS = 100;      // a pause this long before letting go cancels a flick
const SLIDE_MS = 220;

const ORDER = ["open", "closed"];

/** `canSwipe(target)`: whether a touch on `target` may start a swipe now;
 *  `view()`: the current view; `setView(view)`: switches to another view;
 *  `preview(view)`: elements showing that view, for the page moving in. */
export function initViewSwipe({ canSwipe, view, setView, preview }) {
  const main = document.querySelector(".main");
  let g = null;     // { x, y, dx, horizontal, lastX, lastT, v, next, peek } while a finger is down
  let busy = false;

  const neighbour = dir => ORDER[ORDER.indexOf(view()) + dir] ?? null;   // dir +1: to the right

  // The other view's page: a fixed layer over the list column, below the top bar.
  const openPeek = next => {
    const box = main.getBoundingClientRect();
    const top = document.getElementById("topbar").getBoundingClientRect().bottom;
    const peek = document.createElement("div");
    peek.className = "swipe-peek";
    peek.dataset.view = next;
    peek.inert = true;
    peek.setAttribute("aria-hidden", "true");
    Object.assign(peek.style, { top: top + "px", left: box.left + "px", width: box.width + "px" });
    peek.append(...preview(next));
    document.body.append(peek);
    return peek;
  };

  // Moves the list by `x` and the other page beside it, over `ms`.
  const place = (x, ms = 0) => {
    main.style.setProperty("--swipe-x", x + "px");
    main.style.setProperty("--swipe-ms", ms + "ms");
    if (g?.peek) {
      const side = ORDER.indexOf(g.next) > ORDER.indexOf(view()) ? 1 : -1;
      g.peek.style.transition = `transform ${ms}ms ease-out`;
      g.peek.style.transform = `translateX(${x + side * main.clientWidth}px)`;
    }
  };
  const reset = () => {
    main.classList.remove("swiping");
    main.style.removeProperty("--swipe-x");
    main.style.removeProperty("--swipe-ms");
    g?.peek?.remove();
  };
  // Resolves after a transition of `ms`, also if no transitionend comes.
  const settle = ms => new Promise(resolve => setTimeout(resolve, ms + 30));

  document.addEventListener("touchstart", e => {
    if (busy) return;
    g = null;
    if (e.touches.length !== 1 || !canSwipe(e.target) || inScroller(e.target)) return;
    const { clientX: x, clientY: y } = e.touches[0];
    g = { x, y, dx: 0, horizontal: null, lastX: x, lastT: e.timeStamp, v: 0, next: null, peek: null };
  }, { passive: true });

  document.addEventListener("touchmove", e => {
    if (!g || busy) return;
    const { clientX: x, clientY: y } = e.touches[0];
    const dx = x - g.x, dy = y - g.y;
    if (g.horizontal === null) {
      // Undecided until one axis clearly leads; a scroll the browser has
      // already started (not cancelable) stays a scroll.
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
      g.horizontal = e.cancelable && Math.abs(dx) > Math.abs(dy);
      if (!g.horizontal) { g = null; return; }
      main.classList.add("swiping");
      g.next = neighbour(dx < 0 ? 1 : -1) ?? neighbour(dx < 0 ? -1 : 1);
      if (g.next) g.peek = openPeek(g.next);
    }
    if (e.cancelable) e.preventDefault();
    const dt = e.timeStamp - g.lastT;
    if (dt > 0) g.v = 0.7 * ((x - g.lastX) / dt) + 0.3 * g.v;
    g.lastX = x; g.lastT = e.timeStamp;
    g.dx = towardsNext(dx) ? dx : dx * EDGE_GIVE;
    place(g.dx);
  }, { passive: false });

  // Whether a swipe by `dx` brings the other view in (not past an end).
  const towardsNext = dx => g.next && Math.sign(dx) === (ORDER.indexOf(g.next) > ORDER.indexOf(view()) ? -1 : 1);

  document.addEventListener("touchend", async e => {
    if (!g?.horizontal || busy) { if (!busy) g = null; return; }
    const { dx } = g;
    const v = e.timeStamp - g.lastT < HOLD_MS ? g.v : 0;   // held still before letting go: no flick
    const width = main.clientWidth;
    const go = towardsNext(dx) && (Math.abs(dx) > width * COMMIT || (Math.abs(v) > FLICK && Math.sign(v) === Math.sign(dx)));
    busy = true;
    if (go) {
      place(Math.sign(dx) * width, SLIDE_MS);
      await settle(SLIDE_MS);
      setView(g.next);            // the page now shows what the preview showed
    } else {
      place(0, SLIDE_MS);
      await settle(SLIDE_MS);
    }
    reset();
    g = null;
    busy = false;
  });
  document.addEventListener("touchcancel", async () => {
    if (!g?.horizontal || busy) { if (!busy) g = null; return; }
    busy = true;
    place(0, SLIDE_MS);
    await settle(SLIDE_MS);
    reset();
    g = null;
    busy = false;
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

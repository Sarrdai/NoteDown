// Swipe between the notes and the archive (phone and tablet, touch only):
// the archive lies to the right of the notes. Like a pager, the list follows
// the finger anywhere on it (and on the contents) and the other view moves in
// beside it; let go past half the width (or with a flick) and it snaps onto
// the other view, otherwise back. Beyond either end it only gives a little.
// The contents list, where it shows, moves along the same way. The top bar
// and the contents' head stay in place; they are redrawn once the view has
// switched (docs/interaction-concept.md → "Input").
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
 *  `lanes()`: what moves, the list first — [{ move, rect(), preview(view),
 *  peekClass }]: the element shifted by --swipe-x, the area
 *  (`{ top, left, width, height? }`) the other view's page covers, and that
 *  page's elements. Other lanes move in proportion to their width. */
export function initViewSwipe({ canSwipe, view, setView, lanes }) {
  let g = null;     // { x, y, dx, horizontal, lastX, lastT, v, next, lanes } while a finger is down
  let busy = false;

  const neighbour = dir => ORDER[ORDER.indexOf(view()) + dir] ?? null;   // dir +1: to the right

  // A lane with its width and, when there is another view, that view's page:
  // a fixed window over the lane's area (it clips), the page moving inside.
  const openLane = (lane, next) => {
    const r = lane.rect();
    if (!next) return { ...lane, width: r.width, peek: null };
    const peek = document.createElement("div");
    peek.className = ["swipe-peek", lane.peekClass].filter(Boolean).join(" ");
    peek.dataset.view = next;
    peek.inert = true;
    peek.setAttribute("aria-hidden", "true");
    Object.assign(peek.style, { top: r.top + "px", left: r.left + "px", width: r.width + "px" }, r.height ? { height: r.height + "px" } : {});
    const page = document.createElement("div");
    page.className = "swipe-page";
    page.append(...lane.preview(next));
    peek.append(page);
    document.body.append(peek);
    return { ...lane, width: r.width, peek, page };
  };

  // Moves each lane by its share of `x` and the other page beside it, over `ms`.
  const place = (x, ms = 0) => {
    const side = g.next && ORDER.indexOf(g.next) > ORDER.indexOf(view()) ? 1 : -1;
    for (const lane of g.lanes) {
      const lx = x * lane.width / g.lanes[0].width;
      lane.move.style.setProperty("--swipe-x", lx + "px");
      lane.move.style.setProperty("--swipe-ms", ms + "ms");
      if (!lane.peek) continue;
      lane.page.style.transition = `transform ${ms}ms ease-out`;
      lane.page.style.transform = `translateX(${lx + side * lane.width}px)`;
    }
  };
  const reset = () => {
    for (const lane of g.lanes) {
      lane.move.classList.remove("swiping");
      lane.move.style.removeProperty("--swipe-x");
      lane.move.style.removeProperty("--swipe-ms");
      lane.peek?.remove();
    }
  };
  // Resolves after a transition of `ms`, also if no transitionend comes.
  const settle = ms => new Promise(resolve => setTimeout(resolve, ms + 30));

  document.addEventListener("touchstart", e => {
    if (busy) return;
    g = null;
    if (e.touches.length !== 1 || !canSwipe(e.target) || inScroller(e.target)) return;
    const { clientX: x, clientY: y } = e.touches[0];
    g = { x, y, dx: 0, horizontal: null, lastX: x, lastT: e.timeStamp, v: 0, next: null, lanes: [] };
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
      g.next = neighbour(dx < 0 ? 1 : -1) ?? neighbour(dx < 0 ? -1 : 1);
      g.lanes = lanes().map(lane => openLane(lane, g.next));
      for (const lane of g.lanes) lane.move.classList.add("swiping");
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
    const width = g.lanes[0].width;
    const go = towardsNext(dx) && (Math.abs(dx) > width * COMMIT || (Math.abs(v) > FLICK && Math.sign(v) === Math.sign(dx)));
    busy = true;
    if (go) {
      place(Math.sign(dx) * width, SLIDE_MS);
      await settle(SLIDE_MS);
      setView(g.next);            // the pages now show what the previews showed
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

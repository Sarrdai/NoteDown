// When a news post counts as seen (docs/requirements.md → "News"): its card was
// at least half in view (or filled the screen) and the user then left that
// view — another filter, the other view, or the app went to the background —
// so the "new" / "updated" label stays while it is being read. A tap on a
// card counts at once (ui/note-list.js).
import { state, activeCircle, markNewsSeen } from "../store.js";

let viewed = new Set();
let context = null;

const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
  for (const e of entries) {
    const enough = Math.min(e.boundingClientRect.height, e.rootBounds?.height ?? Infinity) / 2;
    if (e.isIntersecting && e.intersectionRect.height >= enough) viewed.add(e.target.dataset.id);
  }
}, { threshold: [0, 0.25, 0.5, 0.75, 1] });

// Takes what was seen so far; `later` marks it after the current render.
function flush(later = false) {
  if (!viewed.size) return;
  const ids = [...viewed];
  viewed = new Set();
  if (later) setTimeout(() => markNewsSeen(ids));
  else markNewsSeen(ids);
}

/** After each render of the list: watches the labelled news cards; a changed view or filter
 *  marks what was seen in the one before (after this render, as it renders again). */
export function trackNews() {
  const now = `${activeCircle()}|${state.view}`;
  if (context !== null && now !== context) flush(true);
  context = now;
  if (!observer) return;
  observer.disconnect();
  for (const el of document.querySelectorAll("#list .note.fresh")) observer.observe(el);
}

document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });

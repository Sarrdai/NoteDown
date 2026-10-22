// The touch pointer (Prototype variant "pointer", phone and tablet): a small button above the + shows a mouse
// pointer beside it. Dragging anywhere on the screen moves the pointer by the same distance, the element under
// its tip shows the preview outline (ui/selection.js → pickTarget); letting go selects it as a right-click
// would, and the pointer is gone. A tap on the button again, Esc or the back key put it away unused; near the
// screen's top or bottom edge the list scrolls along.
import { pickTarget, pickAt, showPick } from "./selection.js";
import { icon } from "./icons.js";

const $ = id => document.getElementById(id);
let tool = null;   // { layer, arrow, x, y, last, frame } while the pointer is out

export function initPointerTool() {
  const btn = $("pointerFab");
  btn.innerHTML = icon("pointer");
  btn.addEventListener("click", () => (tool ? close() : open()));
  document.addEventListener("keydown", e => { if (e.key === "Escape" && tool) close(); });
  window.addEventListener("popstate", () => { if (tool) close(); });
}

function open() {
  const btn = $("pointerFab").getBoundingClientRect();
  const layer = document.createElement("div");
  layer.className = "pointer-layer";
  const arrow = document.createElement("div");
  arrow.className = "pointer-arrow";
  arrow.innerHTML = icon("pointer");
  layer.append(arrow);
  document.body.append(layer);
  $("app").classList.add("pointing");
  // It starts up and to the left of the button, clear of the thumb.
  tool = { layer, arrow, x: btn.left - 56, y: btn.top - 72, last: null, frame: 0 };
  place();
  layer.addEventListener("pointerdown", e => {
    layer.setPointerCapture(e.pointerId);
    tool.last = [e.clientX, e.clientY];
  });
  layer.addEventListener("pointermove", e => {
    if (!tool?.last) return;
    tool.x += e.clientX - tool.last[0];
    tool.y += e.clientY - tool.last[1];
    tool.last = [e.clientX, e.clientY];
    place();
    if (!tool.frame) tool.frame = requestAnimationFrame(scroll);
  });
  layer.addEventListener("pointerup", () => {
    if (!tool?.last) return;
    const target = under();
    close();
    try { navigator.vibrate?.(15); } catch { /* not allowed */ }
    pickAt(target);
  });
  layer.addEventListener("pointercancel", () => { if (tool) tool.last = null; });
}

// The element under the pointer's tip (the layer and the arrow left out).
const under = () => document.elementsFromPoint(tool.x, tool.y).find(el => !tool.layer.contains(el)) || null;

function place() {
  tool.x = Math.min(Math.max(tool.x, 4), window.innerWidth - 4);
  tool.y = Math.min(Math.max(tool.y, 4), window.innerHeight - 4);
  tool.arrow.style.transform = `translate(${tool.x}px, ${tool.y}px)`;
  showPick(pickTarget(under()));
}

function scroll() {
  if (!tool) return;
  const step = tool.y < 90 ? -10 : tool.y > window.innerHeight - 70 ? 10 : 0;
  if (step && tool.last) { window.scrollBy(0, step); place(); }
  tool.frame = step && tool.last ? requestAnimationFrame(scroll) : 0;
}

function close() {
  if (!tool) return;
  cancelAnimationFrame(tool.frame);
  tool.layer.remove();
  tool = null;
  $("app").classList.remove("pointing");
  showPick(null);
}

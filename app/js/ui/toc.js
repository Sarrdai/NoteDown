// Table of contents over the notes in view order: a fixed sidebar on tablet
// and desktop, a bottom sheet on the phone whose handle always peeks out at
// the bottom: a tap on it opens the sheet fully (or closes it), dragging it
// leaves the sheet at any height. In the main view it is also a
// way into multi-select (ui/selection.js): a long-press (or Ctrl+click) on
// an entry selects that section with everything below it, then taps add or
// remove entries.
import { tableOfContents } from "../core/query.js";
import { state, updateSettings } from "../store.js";
import { flashNote } from "./note-list.js";
import { isSelecting, toggleSection, selectSectionRange } from "./selection.js";

const HOLD_MS = 450;
const MOVE_TOLERANCE = 10;
const CLOSE_BELOW = 0.15;   // share of the sheet's range under which a drag closes it
const FLICK = 0.5;          // px/ms that opens fully or closes regardless of the height

const $ = id => document.getElementById(id);
const app = () => $("app");
const phone = window.matchMedia("(max-width: 599px)");
let press = null;     // { key, x, y, timer } while an entry is held
let swallowClick = false;

export function renderToc(notes) {
  const { entries, maxLevel } = tableOfContents(notes);
  const depth = Math.min(state.settings.tocDepth, maxLevel);
  $("tocDepth").textContent = depth;
  $("tocLess").disabled = depth <= 1;
  $("tocMore").disabled = depth >= maxLevel;

  const listEl = $("tocList");
  if (!entries.length) {
    listEl.innerHTML = `<p class="toc-empty">${state.search ? "No matches" : "No notes"}</p>`;
    return;
  }
  const shown = [];
  entries.forEach((e, i) => {
    if (e.level > depth) return;
    const b = document.createElement("button");
    b.className = `toc-entry level-${Math.min(e.level, 6)}` + (e.fromHeading ? "" : " plain")
      + (state.selected.has(e.key) ? " selected" : "");
    b.dataset.key = e.key;
    b.textContent = e.text || "Untitled";
    b.title = b.textContent;
    // Selected sections on hidden levels show as "+n" on the visible entry above them.
    let hidden = 0;
    for (let j = i + 1; j < entries.length && entries[j].level > depth; j++) if (state.selected.has(entries[j].key)) hidden++;
    if (hidden) b.insertAdjacentHTML("beforeend", ` <span class="toc-more">+${hidden}</span>`);
    shown.push(b);
  });
  listEl.replaceChildren(...shown);
}

export function initToc() {
  $("tocLess").addEventListener("click", () => stepDepth(-1));
  $("tocMore").addEventListener("click", () => stepDepth(1));
  $("scrim").addEventListener("click", () => setTocOpen(false));
  initSheetDrag();

  const listEl = $("tocList");
  listEl.addEventListener("pointerdown", e => {
    swallowClick = false;
    const el = e.target.closest(".toc-entry");
    if (!el || e.button !== 0 || isSelecting() || state.view !== "open" || e.ctrlKey || e.metaKey || e.shiftKey) return;
    press = { key: el.dataset.key, x: e.clientX, y: e.clientY, timer: setTimeout(onHold, HOLD_MS) };
  });
  listEl.addEventListener("pointermove", e => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE) cancelPress();
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) listEl.addEventListener(type, cancelPress);
  listEl.addEventListener("contextmenu", e => { if (e.target.closest(".toc-entry")) e.preventDefault(); });
  listEl.addEventListener("click", onClick);
}

function cancelPress() {
  if (!press) return;
  clearTimeout(press.timer);
  press = null;
}

function onHold() {
  const { key } = press;
  press = null;
  swallowClick = true; // the click that follows the release
  try { navigator.vibrate?.(15); } catch { /* not allowed */ }
  toggleSection(key);
}

// Selecting works in the main view only: the archive is read-only.
function onClick(e) {
  const el = e.target.closest(".toc-entry");
  if (!el) return;
  if (swallowClick) { swallowClick = false; return; }
  const key = el.dataset.key;
  const selectable = state.view === "open";
  if (selectable && e.shiftKey) selectSectionRange(key);
  else if (selectable && (e.ctrlKey || e.metaKey || isSelecting())) toggleSection(key);
  else jump(key);
}

export function setTocOpen(open) {
  app().classList.toggle("toc-open", open);
  $("tocPanel").style.height = "";   // opening goes to the full height
  $("tocHandle").setAttribute("aria-expanded", String(open));
}

// Phone: the handle (and the sheet's head, outside its controls) drags the
// sheet; a tap on the handle toggles it. Tablet and desktop hide the handle.
function initSheetDrag() {
  const panel = $("tocPanel");
  let drag = null;   // { y, h, min, max, moved, lastY, lastT, v }

  const onDown = e => {
    if (!phone.matches || e.button !== 0) return;
    if (e.currentTarget !== $("tocHandle") && (e.target.closest("button") || !app().classList.contains("toc-open"))) return;
    const style = getComputedStyle(panel);
    drag = { y: e.clientY, h: panel.offsetHeight, min: parseFloat(style.minHeight), max: parseFloat(style.maxHeight),
      moved: false, lastY: e.clientY, lastT: e.timeStamp, v: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = e => {
    if (!drag) return;
    const dy = drag.y - e.clientY;
    if (!drag.moved && Math.abs(dy) < MOVE_TOLERANCE) return;
    if (!drag.moved) { drag.moved = true; app().classList.add("toc-dragging"); }
    const dt = e.timeStamp - drag.lastT;
    if (dt > 0) drag.v = 0.7 * ((drag.lastY - e.clientY) / dt) + 0.3 * drag.v;
    drag.lastY = e.clientY; drag.lastT = e.timeStamp;
    panel.style.height = Math.min(drag.max, Math.max(drag.min, drag.h + dy)) + "px";
  };
  const onUp = e => {
    if (!drag) return;
    const { moved, min, max, v } = drag;
    drag = null;
    app().classList.remove("toc-dragging");
    if (!moved) {
      if (e.currentTarget === $("tocHandle") && e.type === "pointerup") setTocOpen(!app().classList.contains("toc-open"));
      return;
    }
    const h = panel.offsetHeight;
    if (v < -FLICK || h < min + (max - min) * CLOSE_BELOW) return setTocOpen(false);
    if (v > FLICK) return setTocOpen(true);
    // Left where it was let go.
    app().classList.add("toc-open");
    $("tocHandle").setAttribute("aria-expanded", "true");
  };
  for (const el of [$("tocHandle"), panel.querySelector(".toc-head")]) {
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }
  // Keyboard: the handle is a button.
  $("tocHandle").addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setTocOpen(!app().classList.contains("toc-open")); }
  });
}

function stepDepth(delta) {
  // Clamp against the levels that actually occur, so "+" never goes dead.
  const shownDepth = Number($("tocDepth").textContent);
  updateSettings({ tocDepth: Math.max(1, shownDepth + delta) });
}

function jump(key) {
  const [noteId, index] = key.split("#");
  const noteEl = document.querySelector(`.note[data-id="${noteId}"]`);
  if (!noteEl) return;
  const section = noteEl.querySelector(`.md-section[data-section="${index}"]`);
  const target = (index !== "0" && section && section.firstElementChild) || noteEl;
  if (phone.matches) setTocOpen(false);
  target.scrollIntoView({ block: "start", behavior: phone.matches ? "auto" : "smooth" });
  flashNote(noteId);
}

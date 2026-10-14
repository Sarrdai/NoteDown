// Table of contents over the notes in view order: a fixed sidebar on tablet
// and desktop, a bottom sheet on the phone. In the main view it is also a
// way into multi-select (ui/selection.js): a long-press (or Ctrl+click) on
// an entry selects that section with everything below it, then taps add or
// remove entries.
import { tableOfContents } from "../core/query.js";
import { state, updateSettings } from "../store.js";
import { flashNote } from "./note-list.js";
import { isSelecting, toggleSection, selectSectionRange } from "./selection.js";

const HOLD_MS = 450;
const MOVE_TOLERANCE = 10;

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

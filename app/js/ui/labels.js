// Labels as a filter (#hashtags, core/labels.js): a tap on a label in a note
// filters the list to the notes carrying it; the overview lists every label
// of the view with its count in a Labels tab next to Contents and People,
// a long-press starts picking several (ui/filter-pick.js; a note shows when it
// carries any of them, core/filters.js), and each picked label shows as a
// chip with × above the list (decided 2026-10-15 over a row of label chips
// above the list: after an import there are many labels, and it works like
// the people filter).
import { labelCounts, labelKey } from "../core/labels.js";
import { toggleLabel } from "../core/filters.js";
import { state, setUi } from "../store.js";
import { esc } from "./people.js";
import { wirePick, checkHtml, pickBar } from "./filter-pick.js";

const $ = id => document.getElementById(id);
let onPicked = () => {};

const isActive = name => state.labels.some(l => labelKey(l) === labelKey(name));

function setLabels(labels) {
  setUi({ labels, topId: null });
  window.scrollTo(0, 0);
}

/** Filters the list by this label only (null shows all); in the overview,
 *  picking the only picked one again clears it (`toggle`). */
export function pickLabel(name, toggle = true) {
  const only = state.labels.length === 1 && name !== null && isActive(name);
  setLabels(name === null || (toggle && only) ? [] : [name]);
  onPicked(true);
}

/** Adds the label to the filter or takes it out (null clears all). */
export function toggleLabelFilter(name) {
  setLabels(toggleLabel(state.labels, name));
}

/** Renders the overview; `notes` are the notes the view holds without the label filter. */
export function renderLabels(notes) {
  const counts = labelCounts(notes);
  $("labelList").replaceChildren(...[pickBar("labels", state.labels.length)].filter(Boolean), ...(counts.length ? counts.map(entry)
    : [Object.assign(document.createElement("p"), { className: "people-empty", textContent: "No labels yet. Write #label in a note to add one." })]));
}

function entry({ name, count }) {
  const b = document.createElement("button");
  b.type = "button";
  const on = isActive(name);
  b.className = "people-entry label-entry" + (on ? " active" : "");
  b.dataset.label = name;
  b.innerHTML = `<span class="people-lead">#</span><span class="people-name">${esc(name)}</span><span class="people-count">${count}</span>${checkHtml("labels", on)}`;
  if (on) b.setAttribute("aria-pressed", "true");
  return b;
}

export function initLabels({ onPick }) {
  onPicked = onPick;
  wirePick($("labelList"), {
    tab: "labels",
    selector: "[data-label]",
    picked: el => isActive(el.dataset.label),
    count: () => state.labels.length,
    single: el => setLabels(state.labels.length === 1 && isActive(el.dataset.label) ? [] : [el.dataset.label]),
    toggle: el => toggleLabelFilter(el.dataset.label),
    closes: close => onPicked(close),
  });
  // A label in a note (core/markdown.js renders it as a chip); note-list.js leaves the tap to this.
  $("list").addEventListener("click", e => {
    const el = e.target.closest(".label-chip");
    if (el && !state.selected.size) pickLabel(el.dataset.label, false);
  });
}

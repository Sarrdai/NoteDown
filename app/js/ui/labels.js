// Labels as a filter (#hashtags, core/labels.js): a tap on a label in a note
// filters the list to the notes carrying it; the overview lists every label
// of the view with its count in a Labels tab next to Contents and People,
// the active label shows as a chip with × above the list (decided
// 2026-10-15 over a row of label chips above the list: after an import
// there are many labels, and it works like the people filter).
import { labelCounts, labelKey } from "../core/labels.js";
import { state, setUi } from "../store.js";
import { esc } from "./people.js";

const $ = id => document.getElementById(id);
let onPicked = () => {};

const isActive = name => state.label !== null && labelKey(state.label) === labelKey(name);

/** Filters the list by a label (null shows all); in the overview, picking the
 *  active one again clears it (`toggle`). */
export function pickLabel(name, toggle = true) {
  setUi({ label: name === null || (toggle && isActive(name)) ? null : name, topId: null });
  window.scrollTo(0, 0);
  onPicked(name);
}

/** Renders the overview; `notes` are the notes the view holds without the label filter. */
export function renderLabels(notes) {
  const counts = labelCounts(notes);
  const chip = $("labelChip");
  chip.hidden = state.label === null;
  if (!chip.hidden) $("labelChipLabel").innerHTML = `<span>#${esc(state.label)}</span>`;
  $("labelList").replaceChildren(...(counts.length ? counts.map(entry)
    : [Object.assign(document.createElement("p"), { className: "people-empty", textContent: "No labels yet. Write #label in a note to add one." })]));
}

function entry({ name, count }) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "people-entry label-entry" + (isActive(name) ? " active" : "");
  b.dataset.label = name;
  b.innerHTML = `<span class="people-lead">#</span><span class="people-name">${esc(name)}</span><span class="people-count">${count}</span>`;
  if (isActive(name)) b.setAttribute("aria-pressed", "true");
  return b;
}

export function initLabels({ onPick }) {
  onPicked = onPick;
  const pick = e => {
    const el = e.target.closest("[data-label]");
    if (el) pickLabel(el.dataset.label);
  };
  $("labelList").addEventListener("click", pick);
  $("labelClear").addEventListener("click", () => pickLabel(null));
  // A label in a note (core/markdown.js renders it as a chip); note-list.js leaves the tap to this.
  $("list").addEventListener("click", e => {
    const el = e.target.closest(".label-chip");
    if (el && !state.selected.size) pickLabel(el.dataset.label, false);
  });
}

// Suggestions in the search field (backlog #66): a tap into the field
// offers the filters (∞ Permanent, labels, circles); typing narrows them
// fuzzily and adds the headings that match (core/suggest.js). Picking a
// filter sets it as a chip above the list and empties the field; picking a
// heading puts its text into the search. The full-text search keeps
// filtering the list meanwhile. ↓ / ↑ and Enter pick on the desktop, Esc
// closes the suggestions.
import { suggestions } from "../core/suggest.js";
import { esc } from "./people.js";
import { icon } from "./icons.js";

const $ = id => document.getElementById(id);
const touch = window.matchMedia("(pointer: coarse)");
const TAGS = { permanent: "Filter", label: "Label", circle: "Circle", heading: "Heading" };

let items = [];
let active = -1;
let source = () => ({});
let onPick = () => {};
let leadOf = () => "";

// The text with its matched parts in bold.
function marked(text, ranges) {
  let html = "", at = 0;
  for (const [a, b] of ranges) { html += esc(text.slice(at, a)) + `<b>${esc(text.slice(a, b))}</b>`; at = b; }
  return html + esc(text.slice(at));
}

const isOpen = () => !$("suggest").hidden;

export function closeSuggest() {
  $("suggest").hidden = true;
  $("searchInput").setAttribute("aria-expanded", "false");
  active = -1;
}

// Under the search field (list) or as one row under the top bar (chips), above the phone's keyboard.
function place(box) {
  const view = window.visualViewport;
  const bottom = view ? view.offsetTop + view.height : window.innerHeight;
  if (document.getElementById("app").classList.contains("suggest-chips")) {
    const bar = $("topbar").getBoundingClientRect();
    Object.assign(box.style, { top: bar.bottom + "px", left: bar.left + "px", width: bar.width + "px", maxHeight: "" });
    return;
  }
  const r = $("search").getBoundingClientRect();
  const width = Math.min(Math.max(r.width, 320), window.innerWidth - 16);
  const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
  Object.assign(box.style, { top: r.bottom + 6 + "px", left: left + "px", width: width + "px", maxHeight: Math.max(120, bottom - r.bottom - 14) + "px" });
}

function show() {
  const box = $("suggest");
  items = suggestions($("searchInput").value, source());
  if (!items.length) return closeSuggest();
  active = Math.min(active, items.length - 1);
  box.replaceChildren(...items.map((s, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `suggest-item ${s.kind}` + (i === active ? " active" : "");
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", String(i === active));
    b.innerHTML = `<span class="suggest-lead">${leadOf(s)}</span><span class="suggest-text">${marked(s.text, s.ranges)}</span>`
      + `<span class="suggest-tag">${TAGS[s.kind]}</span>` + (s.count === null ? "" : `<span class="suggest-count">${s.count}</span>`);
    b.addEventListener("click", () => pick(s));
    return b;
  }));
  box.hidden = false;
  $("searchInput").setAttribute("aria-expanded", "true");
  place(box);
  box.querySelector(".active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function pick(s) {
  closeSuggest();
  onPick(s);
  // On touch the keyboard goes down, so the filtered list or the hit can be seen.
  if (touch.matches) $("searchInput").blur();
  else $("searchInput").focus();
}

/** `data()` gives what can be suggested now (core/suggest.js → suggestions),
 *  `pick(suggestion)` applies one, `lead(suggestion)` its leading HTML. */
export function initSearchSuggest({ data, pick: apply, lead }) {
  source = data;
  onPick = apply;
  leadOf = lead;
  const input = $("searchInput");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", "suggest");
  input.setAttribute("aria-expanded", "false");
  input.addEventListener("focus", show);
  input.addEventListener("input", () => { active = -1; show(); });
  // Before the search's own keys (Enter steps through the hits, Esc ends the search).
  input.addEventListener("keydown", e => {
    if (!isOpen()) {
      if (e.key === "ArrowDown") { e.preventDefault(); show(); }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length + 1) % (items.length + 1);
      if (active === items.length) active = -1;
      show();
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault(); e.stopImmediatePropagation();
      pick(items[active]);
    } else if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      closeSuggest();
    }
  }, { capture: true });
  // A tap or click anywhere else closes them; the field and the suggestions keep them.
  document.addEventListener("pointerdown", e => {
    if (isOpen() && !e.target.closest("#suggest, #search")) closeSuggest();
  });
  $("searchClose").addEventListener("click", closeSuggest);
  for (const target of [window, window.visualViewport].filter(Boolean)) target.addEventListener("resize", () => { if (isOpen()) place($("suggest")); });
}

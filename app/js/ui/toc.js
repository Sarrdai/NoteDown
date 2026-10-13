// Table of contents over the notes in view order: a fixed sidebar on tablet
// and desktop, a bottom sheet on the phone.
import { tableOfContents } from "../core/query.js";
import { state, updateSettings } from "../store.js";
import { flashNote } from "./note-list.js";

const app = () => document.getElementById("app");
const phone = window.matchMedia("(max-width: 599px)");

export function renderToc(notes) {
  const { entries, maxLevel } = tableOfContents(notes);
  const depth = Math.min(state.settings.tocDepth, maxLevel);
  document.getElementById("tocDepth").textContent = depth;
  document.getElementById("tocLess").disabled = depth <= 1;
  document.getElementById("tocMore").disabled = depth >= maxLevel;

  const listEl = document.getElementById("tocList");
  const shown = entries.filter(e => e.level <= depth);
  if (!shown.length) {
    listEl.innerHTML = `<p class="toc-empty">${state.search ? "No matches" : "No notes"}</p>`;
    return;
  }
  listEl.replaceChildren(...shown.map(e => {
    const b = document.createElement("button");
    b.className = `toc-entry level-${e.level}` + (e.fromHeading ? "" : " plain");
    b.textContent = e.text || "Untitled";
    b.title = b.textContent;
    b.addEventListener("click", () => jump(e));
    return b;
  }));
}

export function initToc() {
  document.getElementById("tocLess").addEventListener("click", () => stepDepth(-1));
  document.getElementById("tocMore").addEventListener("click", () => stepDepth(1));
  document.getElementById("tocBtn").addEventListener("click", () => setTocOpen(true));
  document.getElementById("scrim").addEventListener("click", () => setTocOpen(false));
}

export function setTocOpen(open) {
  app().classList.toggle("toc-open", open);
}

function stepDepth(delta) {
  // Clamp against the levels that actually occur, so "+" never goes dead.
  const shownDepth = Number(document.getElementById("tocDepth").textContent);
  updateSettings({ tocDepth: Math.max(1, shownDepth + delta) });
}

function jump(entry) {
  const noteEl = document.querySelector(`.note[data-id="${entry.noteId}"]`);
  if (!noteEl) return;
  const target = entry.index >= 0 ? noteEl.querySelectorAll(".md :is(h1,h2,h3,h4,h5,h6)")[entry.index] || noteEl : noteEl;
  if (phone.matches) setTocOpen(false);
  target.scrollIntoView({ block: "start", behavior: phone.matches ? "auto" : "smooth" });
  flashNote(entry.noteId);
}

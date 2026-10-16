// The running stopwatches above the list (docs/requirements.md → "Counters"),
// like the chip of an active filter: one chip each with the text before its
// counter (else the note's title) and the running time, in every view and
// whatever the filters, so a forgotten one is seen. A tap opens the counter's
// pop-up right there, with Stop and Discard (ui/counter.js).
import { allNotes, note, setBody } from "../store.js";
import { counters, runningWatches, changeCounter, clock, elapsedMs } from "../core/counter.js";
import { noteTitle } from "../core/markdown.js";
import { openCounterPop } from "./counter.js";
import { icon } from "./icons.js";

const $ = id => document.getElementById(id);

export function renderWatchBar() {
  const bar = $("watchBar");
  const running = allNotes().filter(n => !n.news).flatMap(n => runningWatches(n.body).map(w => ({ ...w, n })))
    .sort((a, b) => a.since.localeCompare(b.since));
  bar.hidden = !running.length;
  bar.replaceChildren(...running.map(({ n, index, label }) => {
    const c = counters(n.body)[index];
    const b = document.createElement("button");
    b.type = "button";
    b.className = "filter-chip watch-chip";
    Object.assign(b.dataset, {
      note: n.id, index, steps: c.steps.join(" "), kind: c.kind, watch: c.watch.round, since: c.watch.since,
      value: c.value + (c.unit ? " " + c.unit : ""),
    });
    b.innerHTML = `<span>${icon("stopwatch")}<span></span></span><span class="counter-clock"></span>`;
    b.querySelector("span > span").textContent = label || noteTitle(n.body).text || "Untitled";
    b.lastChild.textContent = clock(elapsedMs(c.watch, Date.now()));
    b.title = `${b.querySelector("span > span").textContent} · ${b.dataset.value}`;
    return b;
  }));
}

export function initWatchBar() {
  $("watchBar").addEventListener("click", e => {
    const b = e.target.closest(".watch-chip");
    if (!b) return;
    const { note: id } = b.dataset, index = Number(b.dataset.index);
    openCounterPop(b, change => { if (note(id)) setBody(id, changeCounter(note(id).body, index, change)); });
  });
}

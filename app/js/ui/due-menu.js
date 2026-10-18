// The due-date menu (today, tomorrow, in a week, pick a date, remove): one
// look for a note's due date (ui/toolbar.js → openDueMenu) and a task's
// (backlog #41: its chip in the rendered note and in the editor).
import { openMenu } from "./menu.js";
import { today, addDays, dueLabel, shortDate } from "./format.js";
import { icon } from "./icons.js";

const $ = id => document.getElementById(id);

// What "Pick a date…" sets: the chosen date goes to it.
let picked = null;
let after = () => {};

function wire() {
  if (wire.done) return;
  wire.done = true;
  $("dueInput").addEventListener("change", e => {
    if (picked && e.target.value) picked(e.target.value);
    after();
  });
}

/**
 * Opens the menu at `anchor` for a date `current` ("YYYY-MM-DD" or null).
 * `pick(due)` sets it (null removes it); `done()` runs after a pick (also from
 * the date picker); `more` are menu items added at the end.
 */
export function openDateMenu(anchor, { title, current, pick, done = () => {}, removeLabel = "Remove due date", more = [] }) {
  wire();
  const t = today();
  const set = due => { pick(due); done(); };
  openMenu(anchor, [
    { section: title },
    { label: "Today", checked: current === t, onSelect: () => set(t) },
    { label: "Tomorrow", checked: current === addDays(t, 1), onSelect: () => set(addDays(t, 1)) },
    { label: "In a week", checked: current === addDays(t, 7), onSelect: () => set(addDays(t, 7)) },
    { label: "Pick a date…", onSelect: () => {
      picked = pick;
      after = done;
      const input = $("dueInput");
      input.value = current || t;
      try { input.showPicker(); } catch { input.focus(); input.click(); }
    } },
    ...(current ? [{ separator: true }, { label: removeLabel, onSelect: () => set(null) }] : []),
    ...more,
  ]);
}

/** The menu for a task's date. */
export function openTaskDueMenu(anchor, current, pick, done) {
  openDateMenu(anchor, { title: "Task due date", current, pick, done, removeLabel: "Remove task date" });
}

/**
 * A task's chip (core/markdown.js renders it with `data-due`) gets its label and colour as the note's due chip:
 * red overdue, accent today. A done or cancelled task's date, or one in a read-only note, is shown plain.
 */
export function fillTaskDue(chip, { plain = false, readOnly = false } = {}) {
  const due = chip.dataset.due;
  const d = plain ? { text: shortDate(due), kind: "plain" } : dueLabel(due);
  chip.className = `chip task-due ${d.kind}`;
  chip.innerHTML = icon("calendar") + `<span></span>`;
  chip.lastChild.textContent = d.text;
  chip.setAttribute("aria-label", d.text + (readOnly ? "" : ", change task date"));
  chip.disabled = readOnly;
}

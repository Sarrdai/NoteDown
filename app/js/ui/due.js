// The Due page (backlog #65): everything that is due in one list, item by item — the open notes' own due dates
// and the open tasks' dates — grouped Overdue / Today / Next 7 days / Later (core/due-list.js). A page of the
// panel container (ui/sync-panel.js), opened by the top bar's calendar button and by a tapped reminder.
//
// Ticking a task or closing a note works as in the list (setBody / toggleStatus), but the row stays where it is,
// shown done and undoable, until the page is left: rows never jump away under the finger.
import { state, allNotes, setBody, subscribe } from "../store.js";
import { toggleTask, noteTitle } from "../core/markdown.js";
import { dueItems, dueGroups, titleOfNotes } from "../core/due-list.js";
import { refOf } from "../core/note-ref.js";
import { registerPage, openPanel, closePanel, refreshPage, isPanelOpen, panelPage } from "./sync-panel.js";
import { toggleStatus } from "./note-list.js";
import { afterLeave } from "./dom.js";
import { shortDate, today } from "./format.js";
import { icon } from "./icons.js";
import { h } from "./dom.js";

const keyOf = it => it.kind === "note" ? `note:${it.id}` : `task:${it.id}:${it.index}`;
const ticked = new Map();   // key → the item as it was when ticked (it leaves the notes' due items once done)
const kept = new Map();     // the open task rows of a note closed in this visit, which stay too
let laterOpen = false;

/** Opens the Due page. */
export function openDue() {
  if (isPanelOpen() && panelPage() === "due") return;
  ticked.clear();
  kept.clear();
  laterOpen = false;
  openPanel("due");
}

const title = id => noteTitle(allNotes().find(n => refOf(n) === id)?.body || "").text || "Untitled";

function showNote(id) {
  closePanel();
  afterLeave(() => document.dispatchEvent(new CustomEvent("notedown:show-note", { detail: { id } })));
}

function tick(it, done) {
  if (done) ticked.set(keyOf(it), it); else ticked.delete(keyOf(it));
  if (it.kind === "task") {
    const n = allNotes().find(x => refOf(x) === it.id);
    if (n) setBody(it.id, toggleTask(n.body, it.index));
  } else {
    if (done) for (const t of dueItems(allNotes(), today())) if (t.id === it.id) kept.set(keyOf(t), t);
    toggleStatus(it.id);
  }
  refreshPage({ keepScroll: true });
  document.querySelector(`#syncBody [data-key="${keyOf(it)}"] :is(input, button.due-lead)`)?.focus({ preventScroll: true });
}

function rowOf(it, groupKey) {
  const done = ticked.has(keyOf(it));
  const note = allNotes().find(n => refOf(n) === it.id);
  const name = title(it.id);
  const lead = it.kind === "task"
    ? h("label", { class: "due-lead" }, h("input", {
      type: "checkbox", class: "task due-task", checked: done, "aria-label": "Done: " + it.text, disabled: note?.status === "closed",
      onchange: e => tick(it, e.target.checked),
    }))
    : note?.status === "permanent"
      ? h("span", { class: "due-lead permanent-mark", role: "img", "aria-label": "Permanent note", html: icon("permanent") })
      : h("button", {
        type: "button", class: "status due-lead", "aria-label": (done ? "Reopen note: " : "Close note: ") + name,
        onclick: () => tick(it, !done), html: `<span class="ring">${icon("check")}</span>`,
      });
  const date = groupKey === "today" ? null
    : h("span", { class: "due-date" + (groupKey === "overdue" ? " overdue" : "") }, shortDate(it.day));
  return h("li", { class: "sheet-row due-row" + (done ? " done" : ""), "data-key": keyOf(it) },
    lead,
    h("button", { type: "button", class: "due-main", onclick: () => showNote(it.id) },
      h("span", { class: "row-text" },
        h("span", { class: "row-title" + (it.kind === "note" ? "" : " plain") }, it.kind === "note" ? name : it.text),
        it.kind === "task" && h("span", { class: "row-sub" }, "in " + name)),
      date));
}

function groupEl(g) {
  const fold = g.key === "later";
  const open = !fold || laterOpen;
  const label = [g.title, h("span", { class: "due-count" }, String(g.items.length))];
  const head = fold
    ? h("h3", { class: "sheet-section due-section " + g.key },
      h("button", { type: "button", class: "due-fold", "aria-expanded": String(open), onclick: () => { laterOpen = !laterOpen; refreshPage({ keepScroll: true }); } },
        h("span", { class: "due-chevron", html: icon("down") }), label))
    : h("h3", { class: "sheet-section due-section " + g.key }, label);
  return [head, open && h("ul", { class: "sheet-card" }, g.items.map(it => rowOf(it, g.key)))];
}

registerPage("due", {
  title: "Due",
  render: () => {
    const notes = allNotes();
    const items = dueItems(notes, today());
    const seen = new Set(items.map(keyOf));
    for (const [k, it] of [...kept, ...ticked]) if (!seen.has(k)) { seen.add(k); items.push(it); }
    const groups = dueGroups(items, today(), titleOfNotes(notes));
    if (!groups.length) return [h("p", { class: "sheet-text muted" }, "Nothing is due. Notes and tasks with a due date show up here.")];
    return groups.flatMap(groupEl);
  },
});

// Follows changes made elsewhere (sync, another tab) while the page is open.
subscribe(() => { if (isPanelOpen() && panelPage() === "due") refreshPage({ keepScroll: true }); });

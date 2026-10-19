// The arrange dialog of Shelves (backlog #24; the sort named My order until 2026-10-19), opened by Tidy up…: the notes
// of the current view in two parts — sorted ones on top, then a line and the
// pile, the notes not sorted in yet. Rows move by drag or arrow keys (the grip of the merge order
// dialog), + adds a note at the end of the sorted part, − takes it out.
// Below the list a sort (any but the custom ones) orders the unsorted rows,
// so the next ones to sort in are easy to find. "Shelf" adds a shelf (a section
// divider in the code) above the line: a titled row that moves like a note and groups
// the notes below it; its × removes it (the notes stay where they are). A note's
// move button moves it into a section of another note (ui/move-to.js): its row goes.
import { noteTitle } from "../core/markdown.js";
import { SORT_KEYS, DIR_LABELS, sortNotes, sectionId, sectionTitle } from "../core/query.js";
import { orderGrip } from "./selection.js";
import { openMenu } from "./menu.js";
import { icon } from "./icons.js";
import { refOf } from "../core/note-ref.js";
import { moveTo } from "./move-to.js";
import { showSnackbar } from "./snackbar.js";

const $ = id => document.getElementById(id);
let onSave = null;
let notes = new Map();   // id → note of the rows
let view = "open";
let unsortedBy = { key: "modified", dir: "desc" };   // as the list shows them

/** Opens the dialog over `sorted` rows (notes and { section: id }, see
 *  core/query.js → arrangeRows) and `unsorted` notes; `save(ids)` gets the
 *  ids above the line, in order, section entries included. */
export function openArrange({ title = "Shelves", hint = "Only you see these shelves.", sorted, unsorted, save, view: inView = "open" }) {
  onSave = save;
  notes = new Map([...sorted, ...unsorted].filter(n => n.id).map(n => [refOf(n), n]));
  view = inView;
  unsortedBy = { key: "modified", dir: "desc" };
  $("arrangeSortLabel").textContent = SORT_KEYS[unsortedBy.key].label;
  $("arrangeTitle").textContent = title;
  $("arrangeHint").textContent = hint + " Drag notes above the line to sort them, or tap + and −. Shelves hold the notes below them.";
  $("arrangeList").replaceChildren(...sorted.map(r => r.section ? sectionRow(sectionTitle(r.section)) : row(r)), line(), ...unsorted.map(row));
  refresh();
  $("arrangeDialog").hidden = false;
  $("arrangeOk").focus({ preventScroll: true, focusVisible: false });
}

const isOpen = () => !$("arrangeDialog").hidden;

function close() {
  onSave = null;
  $("arrangeDialog").hidden = true;
}

function row(n) {
  const li = document.createElement("li");
  li.className = "order-item";
  li.dataset.id = refOf(n);
  const t = noteTitle(n.body);
  const label = document.createElement("span");
  label.className = "order-text" + (t.fromHeading ? "" : " plain");
  label.textContent = t.text || "Untitled";
  const toggle = document.createElement("button");
  toggle.className = "icon-btn small arrange-toggle";
  toggle.addEventListener("click", () => {
    const divider = $("arrangeList").querySelector(".arrange-line");
    if (li.classList.contains("unsorted")) divider.before(li); else divider.after(li);
    refresh();
  });
  const move = document.createElement("button");
  move.className = "icon-btn small arrange-move";
  move.setAttribute("aria-label", "Move to…");
  move.title = "Move to…";
  move.innerHTML = icon("moveto");
  move.addEventListener("click", () => {
    const id = refOf(n);
    moveTo({
      parts: [{ noteId: id, from: 0, to: 1, whole: true }], sources: { [id]: n }, candidates: [...notes.values()],
      onDone: (target, undo, message) => { li.remove(); notes.delete(id); refresh(); showSnackbar(message, undo); },
    });
  });
  li.append(toggle, label, move, orderGrip(li));
  return li;
}

// A shelf (section divider): its title is edited in place.
function sectionRow(title) {
  const li = document.createElement("li");
  li.className = "order-item arrange-section";
  const input = document.createElement("input");
  input.className = "arrange-section-title";
  input.value = title;
  input.placeholder = "Shelf";
  input.setAttribute("aria-label", "Shelf name");
  input.addEventListener("keydown", e => { if (e.key === "Enter") input.blur(); });
  const remove = document.createElement("button");
  remove.className = "icon-btn small";
  remove.setAttribute("aria-label", "Remove shelf");
  remove.innerHTML = icon("close");
  remove.addEventListener("click", () => li.remove());
  li.append(input, remove, orderGrip(li));
  return li;
}

// A new shelf goes right above the line: + on a note then sorts it in there.
function addSection() {
  const li = sectionRow("New shelf");
  $("arrangeList").querySelector(".arrange-line").before(li);
  const input = li.querySelector("input");
  input.focus({ preventScroll: true });
  input.select();
  li.scrollIntoView({ block: "nearest" });
}

function line() {
  const li = document.createElement("li");
  li.className = "arrange-line";
  li.textContent = "Pile";
  return li;
}

// Orders the rows below the line; rows above it keep their order.
function sortUnsorted(by) {
  unsortedBy = by;
  $("arrangeSortLabel").textContent = SORT_KEYS[by.key].label;
  const list = $("arrangeList");
  const rows = [...list.querySelectorAll(".order-item.unsorted")];
  const byId = new Map(rows.map(li => [li.dataset.id, li]));
  list.append(...sortNotes(rows.map(li => notes.get(li.dataset.id)), by).map(n => byId.get(refOf(n))));
}

function sortMenu() {
  const keys = Object.entries(SORT_KEYS).filter(([, v]) => !v.custom && (!v.views || v.views.includes(view)));
  const dirs = DIR_LABELS[unsortedBy.key] || DIR_LABELS.default;
  openMenu($("arrangeSort"), [
    { section: "Sort the pile by" },
    ...keys.map(([key, v]) => ({ label: v.label, checked: unsortedBy.key === key, onSelect: () => sortUnsorted({ key, dir: key === "title" || key === "due" ? "asc" : "desc" }) })),
    { separator: true },
    { label: dirs[1], checked: unsortedBy.dir === "desc", onSelect: () => sortUnsorted({ ...unsortedBy, dir: "desc" }) },
    { label: dirs[0], checked: unsortedBy.dir === "asc", onSelect: () => sortUnsorted({ ...unsortedBy, dir: "asc" }) },
  ]);
}

// Rows below the line are unsorted: their button adds, the others' removes.
// Only rows that changed sides get a new icon: replacing the icon under a
// press would swallow the click on the button (refresh runs on pointerup).
// A section carried below the line goes back right above it.
function refresh() {
  let below = false;
  for (const li of [...$("arrangeList").children]) {
    if (li.classList.contains("arrange-line")) { below = true; continue; }
    if (li.classList.contains("arrange-section")) {
      if (below) $("arrangeList").querySelector(".arrange-line").before(li);
      continue;
    }
    const b = li.querySelector(".arrange-toggle");
    if (b.hasChildNodes() && li.classList.contains("unsorted") === below) continue;
    li.classList.toggle("unsorted", below);
    b.innerHTML = icon(below ? "plus" : "minus");
    b.setAttribute("aria-label", below ? "Add to the order" : "Take out of the order");
  }
}

export function initArrange() {
  $("arrangeSort").querySelector(".btn-icon").innerHTML = icon("sort");
  $("arrangeSort").addEventListener("click", sortMenu);
  $("arrangeCancel").addEventListener("click", close);
  $("arrangeAddSection").querySelector(".btn-icon").innerHTML = icon("plus");
  $("arrangeAddSection").addEventListener("click", addSection);
  $("arrangeDialog").addEventListener("click", e => { if (e.target === $("arrangeDialog")) close(); });
  $("arrangeOk").addEventListener("click", () => {
    const ids = [];
    for (const li of $("arrangeList").children) {
      if (li.classList.contains("arrange-line")) break;
      ids.push(li.classList.contains("arrange-section") ? sectionId(li.querySelector("input").value.trim() || "Section") : li.dataset.id);
    }
    const save = onSave;
    close();
    save(ids);
  });
  // A drag or an arrow key may carry a row across the line; a drag may end
  // outside the list.
  $("arrangeList").addEventListener("keyup", refresh);
  document.addEventListener("pointerup", () => { if (isOpen()) refresh(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && isOpen()) close(); });
}

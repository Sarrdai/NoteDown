// The custom order's arrange dialog (backlog #24): the notes of the current
// view in two parts — sorted ones on top, then a line and the notes "not
// sorted yet". Rows move by drag or arrow keys (the grip of the merge order
// dialog), + adds a note at the end of the sorted part, − takes it out.
// Below the list a sort (any but the custom ones) orders the unsorted rows,
// so the next ones to sort in are easy to find.
import { noteTitle } from "../core/markdown.js";
import { SORT_KEYS, DIR_LABELS, sortNotes } from "../core/query.js";
import { orderGrip } from "./selection.js";
import { openMenu } from "./menu.js";
import { icon } from "./icons.js";

const $ = id => document.getElementById(id);
let onSave = null;
let notes = new Map();   // id → note of the rows
let archive = false;
let unsortedBy = { key: "modified", dir: "desc" };   // as the list shows them

/** Opens the dialog over `sorted` and `unsorted` notes; `save(ids)` gets the
 *  ids above the line, in order. */
export function openArrange({ title = "Custom order", hint = "Only you see this order.", sorted, unsorted, save, archive: inArchive = false }) {
  onSave = save;
  notes = new Map([...sorted, ...unsorted].map(n => [n.id, n]));
  archive = inArchive;
  unsortedBy = { key: "modified", dir: "desc" };
  $("arrangeSortLabel").textContent = SORT_KEYS[unsortedBy.key].label;
  $("arrangeTitle").textContent = title;
  $("arrangeHint").textContent = hint + " Drag notes above the line to sort them, or tap + and −.";
  $("arrangeList").replaceChildren(...sorted.map(row), line(), ...unsorted.map(row));
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
  li.dataset.id = n.id;
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
  li.append(toggle, label, orderGrip(li));
  return li;
}

function line() {
  const li = document.createElement("li");
  li.className = "arrange-line";
  li.textContent = "Not sorted yet";
  return li;
}

// Orders the rows below the line; rows above it keep their order.
function sortUnsorted(by) {
  unsortedBy = by;
  $("arrangeSortLabel").textContent = SORT_KEYS[by.key].label;
  const list = $("arrangeList");
  const rows = [...list.querySelectorAll(".order-item.unsorted")];
  const byId = new Map(rows.map(li => [li.dataset.id, li]));
  list.append(...sortNotes(rows.map(li => notes.get(li.dataset.id)), by).map(n => byId.get(n.id)));
}

function sortMenu() {
  const keys = Object.entries(SORT_KEYS).filter(([, v]) => !v.custom && (!v.archiveOnly || archive));
  const dirs = DIR_LABELS[unsortedBy.key] || DIR_LABELS.default;
  openMenu($("arrangeSort"), [
    { section: "Sort not sorted yet by" },
    ...keys.map(([key, v]) => ({ label: v.label, checked: unsortedBy.key === key, onSelect: () => sortUnsorted({ key, dir: key === "title" || key === "due" ? "asc" : "desc" }) })),
    { separator: true },
    { label: dirs[1], checked: unsortedBy.dir === "desc", onSelect: () => sortUnsorted({ ...unsortedBy, dir: "desc" }) },
    { label: dirs[0], checked: unsortedBy.dir === "asc", onSelect: () => sortUnsorted({ ...unsortedBy, dir: "asc" }) },
  ]);
}

// Rows below the line are unsorted: their button adds, the others' removes.
// Only rows that changed sides get a new icon: replacing the icon under a
// press would swallow the click on the button (refresh runs on pointerup).
function refresh() {
  let below = false;
  for (const li of $("arrangeList").children) {
    if (li.classList.contains("arrange-line")) { below = true; continue; }
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
  $("arrangeDialog").addEventListener("click", e => { if (e.target === $("arrangeDialog")) close(); });
  $("arrangeOk").addEventListener("click", () => {
    const ids = [];
    for (const li of $("arrangeList").children) {
      if (li.classList.contains("arrange-line")) break;
      ids.push(li.dataset.id);
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

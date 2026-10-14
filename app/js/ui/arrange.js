// The custom order's arrange dialog (backlog #24): the notes of the current
// view in two parts — sorted ones on top, then a line and the notes "not
// sorted yet". Rows move by drag or arrow keys (the grip of the merge order
// dialog), + adds a note at the end of the sorted part, − takes it out.
import { noteTitle } from "../core/markdown.js";
import { orderGrip } from "./selection.js";
import { icon } from "./icons.js";

const $ = id => document.getElementById(id);
let onSave = null;

/** Opens the dialog over `sorted` and `unsorted` notes; `save(ids)` gets the
 *  ids above the line, in order. */
export function openArrange({ title = "Custom order", hint = "Only you see this order.", sorted, unsorted, save }) {
  onSave = save;
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

// Rows below the line are unsorted: their button adds, the others' removes.
function refresh() {
  let below = false;
  for (const li of $("arrangeList").children) {
    if (li.classList.contains("arrange-line")) { below = true; continue; }
    li.classList.toggle("unsorted", below);
    const b = li.querySelector(".arrange-toggle");
    b.innerHTML = icon(below ? "plus" : "minus");
    b.setAttribute("aria-label", below ? "Add to the order" : "Take out of the order");
  }
}

export function initArrange() {
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
  // A drag or an arrow key may carry a row across the line.
  for (const type of ["pointerup", "keyup"]) $("arrangeList").addEventListener(type, refresh);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && isOpen()) close(); });
}

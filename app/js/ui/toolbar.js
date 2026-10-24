// The editing toolbar: Markdown helpers, a counter, undo / redo and Done. It
// sits above the on-screen keyboard on touch devices and floats at the
// bottom of the list on the desktop. Also the due-date menu, which the
// note's due chip opens (the toolbar has no due-date button since 2026-10-16). Copy to… copies a marked
// passage into another note (ui/move-to.js); it shows only while a passage is marked (decided 2026-10-24
// over always showing it greyed out: the bar stays as it was).
import { state, note, setDue } from "../store.js";
import { currentEditor, endEdit, onEditingChange } from "./note-list.js";
import { openDateMenu, openTaskDueMenu } from "./due-menu.js";
import { icon } from "./icons.js";
import { lineDue, setLineDue } from "../core/task-due.js";
import { toggleTaskItem, listPrefix } from "../core/md-commands.js";
import { openSettings } from "./settings.js";
import { openLookPicker } from "./look-picker.js";

const BUTTONS = [
  ["copyTo", "Copy to… (the marked passage)", "copy"],
  ["heading", "Heading", "heading"],
  ["bullet", "Bullet list", "list"],
  ["task", "Checkbox", "checkbox"],
  ["taskDue", "Task due date", "calendar"],   // backlog #41: the date of the task the caret is on
  ["outdent", "Outdent (Shift+Tab)", "outdent"],
  ["indent", "Indent (Tab)", "indent"],
  ["bold", "Bold (Ctrl+B)", "bold"],
  ["italic", "Italic (Ctrl+I)", "italic"],
  ["highlight", "Highlight", "highlight"],
  ["link", "Link (Ctrl+K)", "link"],
  ["noteLink", "Link to a note ([[)", "notelink"],
  ["media", "Image or video from the web", "image"],
  ["counter", "Counter (hold: time counter with stopwatch)", "counter"],
  ["rating", "Star rating", "star"],
  ["look", "Color and motif", "look"],
  ["undo", "Undo (Ctrl+Z)", "undo"],
  ["redo", "Redo (Ctrl+Shift+Z)", "redo"],
];

const $ = id => document.getElementById(id);
const HOLD_MS = 450;

/** `onDue(id)`: runs after a due date was set from the menu; `onCopyTo(text)`: Copy to… for a marked passage. */
export function initToolbar({ onDue, onCopyTo }) {
  dueSet = onDue;
  const bar = $("toolbar");
  $("toolbarButtons").replaceChildren(...BUTTONS.map(([cmd, label, ic]) => {
    const b = document.createElement("button");
    b.className = "tool";
    b.dataset.cmd = cmd;
    b.title = label;
    b.setAttribute("aria-label", label);
    b.innerHTML = icon(ic);
    return b;
  }));
  // Buttons must not take focus, or the editor (and the keyboard) would close.
  // A long-press (desktop: right-click) on Counter adds a time counter with a stopwatch.
  let hold = null, held = false;
  const timeCounter = () => { held = true; currentEditor()?.run("timeCounter"); };
  bar.addEventListener("pointerdown", e => {
    const b = e.target.closest("button");
    if (b) e.preventDefault();
    held = false;
    if (b?.dataset.cmd === "counter" && e.button === 0) hold = setTimeout(timeCounter, HOLD_MS);
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) bar.addEventListener(type, () => clearTimeout(hold));
  bar.addEventListener("contextmenu", e => {
    if (e.target.closest("button")?.dataset.cmd !== "counter") return;
    e.preventDefault();
    clearTimeout(hold);
    if (!held) timeCounter();
  });
  bar.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (held) { held = false; return; }
    if (b.id === "toolbarDone") return endEdit();
    if (b.dataset.cmd === "look") return openLookPicker(b, [state.editingId]);
    if (b.dataset.cmd === "taskDue") return caretTaskDue(b);
    if (b.dataset.cmd === "copyTo") { const t = marked(); if (t) onCopyTo(t); return; }
    currentEditor()?.run(b.dataset.cmd);
  });

  // Whether a passage is marked: the editor's selection settles after the browser's selectionchange.
  const copy = bar.querySelector('[data-cmd="copyTo"]');
  const markSelection = () => setTimeout(() => {
    const has = !!marked();
    bar.classList.toggle("has-selection", has);
    copy.disabled = !has;
  });
  document.addEventListener("selectionchange", markSelection);

  onEditingChange(id => {
    markSelection();
    bar.hidden = !id;
    document.getElementById("app").classList.toggle("is-editing", Boolean(id));
    place();
  });

  // Keep the bar above the on-screen keyboard where the browser overlays it.
  const vv = window.visualViewport;
  function place() {
    if (!vv || bar.hidden) return;
    const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    bar.style.transform = offset ? `translateY(${-offset}px)` : "";
  }
  vv?.addEventListener("resize", place);
  vv?.addEventListener("scroll", place);
  // When the keyboard comes up (the viewport shrinks or the bar moves or
  // grows), the caret may now lie behind it: bring it back into view.
  const reveal = () => currentEditor()?.revealCaret();
  vv?.addEventListener("resize", reveal);
  window.addEventListener("resize", reveal);
  new ResizeObserver(reveal).observe(bar);
}

let dueSet = () => {};

// The passage marked in the editor, or "".
function marked() {
  const v = currentEditor()?.view;
  const sel = v?.state.selection.main;
  return sel && !sel.empty ? v.state.sliceDoc(sel.from, sel.to).trim() : "";
}
const refocus = id => { if (id && id === state.editingId) currentEditor()?.view.focus(); };

/** The due-date menu of a note: from the note's due chip. */
export function openDueMenu(anchor, id) {
  const n = note(id);
  if (!n) return;
  openDateMenu(anchor, {
    title: "Due date",
    current: n.due || null,
    pick: due => { setDue(id, due); dueSet(id); },
    done: () => refocus(id),
    // Reminders are set in the settings; here is where they are looked for.
    more: [{ separator: true }, { label: "Reminders…", icon: "bell", onSelect: () => openSettings("reminders") }],
  });
}

// The toolbar's Task due date: sets the date of the task the caret is on; any other line becomes a task first.
function caretTaskDue(anchor) {
  const ed = currentEditor();
  if (!ed) return;
  const id = state.editingId;
  const lineNo = ed.view.state.doc.lineAt(ed.view.state.selection.main.head).number;
  openTaskDueMenu(anchor, lineDue(ed.view.state.doc.line(lineNo).text), due => {
    if (currentEditor() !== ed) return;
    const line = ed.view.state.doc.line(Math.min(lineNo, ed.view.state.doc.lines));
    const task = listPrefix(line.text)?.task ? line.text : toggleTaskItem(line.text);
    const text = setLineDue(task, due);
    if (text !== line.text) ed.view.dispatch({ changes: { from: line.from, to: line.to, insert: text }, userEvent: "input" });
  }, () => refocus(id));
}

// The editing toolbar: Markdown helpers, due date, dictation at the cursor
// and Done. It sits above the on-screen keyboard on touch devices and
// floats at the bottom of the list on the desktop.
import { state, note, setDue } from "../store.js";
import { currentEditor, endEdit, onEditingChange } from "./note-list.js";
import { dictationAvailable, startDictation } from "./dictation.js";
import { openMenu } from "./menu.js";
import { showSnackbar } from "./snackbar.js";
import { today, addDays } from "./format.js";
import { icon } from "./icons.js";

const BUTTONS = [
  ["heading", "Heading", "heading"],
  ["bullet", "Bullet list", "list"],
  ["task", "Checkbox", "checkbox"],
  ["outdent", "Outdent (Shift+Tab)", "outdent"],
  ["indent", "Indent (Tab)", "indent"],
  ["bold", "Bold (Ctrl+B)", "bold"],
  ["italic", "Italic (Ctrl+I)", "italic"],
  ["link", "Link (Ctrl+K)", "link"],
  ["media", "Image or video from the web", "image"],
  ["due", "Due date", "calendar"],
  ["mic", "Dictate at cursor", "mic"],
  ["undo", "Undo (Ctrl+Z)", "undo"],
  ["redo", "Redo (Ctrl+Shift+Z)", "redo"],
];

const $ = id => document.getElementById(id);
let dictation = null;

/** `onDue(id)`: runs after a due date was set from the menu. */
export function initToolbar({ onDue }) {
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
  bar.addEventListener("pointerdown", e => { if (e.target.closest("button")) e.preventDefault(); });
  bar.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.id === "toolbarDone") return endEdit();
    const cmd = b.dataset.cmd;
    if (cmd === "due") return openDueMenu(b, state.editingId);
    if (cmd === "mic") return toggleDictation(b);
    currentEditor()?.run(cmd);
  });

  $("dueInput").addEventListener("change", e => {
    if (dueTarget && e.target.value) { setDue(dueTarget, e.target.value); dueSet(dueTarget); }
    refocus(dueTarget);
  });

  onEditingChange(id => {
    bar.hidden = !id;
    document.getElementById("app").classList.toggle("is-editing", Boolean(id));
    if (!id) stopDictation();
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

// The note whose date "Pick a date…" sets.
let dueTarget = null;
let dueSet = () => {};
const refocus = id => { if (id && id === state.editingId) currentEditor()?.view.focus(); };

/** The due-date menu of a note: from the toolbar and from the note's due chip. */
export function openDueMenu(anchor, id) {
  const n = note(id);
  if (!n) return;
  const t = today();
  const pick = due => { setDue(id, due); dueSet(id); refocus(id); };
  openMenu(anchor, [
    { section: "Due date" },
    { label: "Today", checked: n.due === t, onSelect: () => pick(t) },
    { label: "Tomorrow", checked: n.due === addDays(t, 1), onSelect: () => pick(addDays(t, 1)) },
    { label: "In a week", checked: n.due === addDays(t, 7), onSelect: () => pick(addDays(t, 7)) },
    { label: "Pick a date…", onSelect: () => {
      dueTarget = id;
      const input = $("dueInput");
      input.value = n.due || t;
      try { input.showPicker(); } catch { input.focus(); input.click(); }
    } },
    ...(n.due ? [{ separator: true }, { label: "Remove due date", onSelect: () => pick(null) }] : []),
  ]);
}

function toggleDictation(button) {
  if (dictation) return stopDictation();
  if (!dictationAvailable()) {
    showSnackbar(window.isSecureContext ? "Dictation isn't available in this browser" : "Dictation needs https or localhost");
    return;
  }
  button.classList.add("active");
  dictation = startDictation({
    onInterim: t => currentEditor()?.setInterim(t),
    onFinal: t => { const ed = currentEditor(); if (ed) { ed.setInterim(""); ed.insertDictation(t); } },
    onLevel: v => button.style.setProperty("--level", v.toFixed(3)),
    onError: code => { showSnackbar(code === "not-allowed" ? "Microphone access was denied" : "Dictation stopped: " + code); stopDictation(); },
  });
}

function stopDictation() {
  if (!dictation) return;
  const d = dictation;
  dictation = null;
  d.stop();
  const b = document.querySelector('.tool[data-cmd="mic"]');
  b.classList.remove("active");
  b.style.removeProperty("--level");
  currentEditor()?.setInterim("");
}

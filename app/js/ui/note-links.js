// Links between notes in the view and the editor (backlog #45, core/note-links.js):
// a rendered link jumps to its note (main.js → showNote, by the "notedown:show-note"
// event) or, when the user can't see that note, says so; typing `[[` in the
// editor (or the toolbar's "Link to a note") opens a picker of the notes the
// edited note may link to.
import { ViewPlugin, keymap, Prec } from "../../vendor/codemirror.esm.js";
import { linkTrigger, linkCandidates, noteLink } from "../core/note-links.js";
import { noteTitle } from "../core/markdown.js";
import { circleKey } from "../core/sharing.js";
import { allNotes, circleOf } from "../store.js";
import { showSnackbar } from "./snackbar.js";
import { esc } from "./people.js";

const visibleNote = id => allNotes().find(n => n.id === id && !n.news) || null;

/** Marks the note links inside `root`: a link the user can follow names its note's current title in its
 *  tooltip, one to a note they can't see is shown as unavailable. */
export function applyNoteLinks(root) {
  root.querySelectorAll("a.note-link").forEach(a => {
    const target = visibleNote(a.dataset.note);
    a.classList.toggle("unavailable", !target);
    a.title = target ? "Go to “" + (noteTitle(target.body).text || "Untitled") + "”" : "Note not available";
  });
}

/** Follows a rendered note link: shows its note, or says it isn't available. */
export function followNoteLink(a) {
  const id = a.dataset.note;
  if (!visibleNote(id)) return showSnackbar("This note isn't available to you");
  document.dispatchEvent(new CustomEvent("notedown:show-note", { detail: { id } }));
}

// Enter on a focused link follows it, as a tap does.
document.addEventListener("keydown", e => {
  const a = e.key === "Enter" && e.target.closest?.("#list .note-body a.note-link");
  if (a && !e.target.closest(".editor-host")) { e.preventDefault(); followNoteLink(a); }
});

// ---------- the [[ picker in the editor ----------

/** The editor extension of the note `fromId`: typing `[[` lists the notes it may link to; picking one
 *  replaces `[[…` with a link showing that note's title. */
export function linkPicker(fromId) {
  let box = null, items = [], index = 0, trigger = null, view = null, dismissed = -1;
  const circle = id => circleKey(circleOf(id));

  const close = () => { box?.remove(); box = null; items = []; trigger = null; };
  const choose = i => {
    const c = items[i];
    if (!c || !trigger || !view) return close();
    const head = view.state.selection.main.head;
    const insert = noteLink(c.id, c.title);
    view.dispatch({ changes: { from: trigger.at, to: head, insert }, selection: { anchor: trigger.at + insert.length }, userEvent: "input" });
    close();
  };
  const paint = () => {
    box.innerHTML = items.length
      ? items.map((c, i) => `<button type="button" class="link-pick${i === index ? " active" : ""}${c.closed ? " closed" : ""}" data-i="${i}" role="option" aria-selected="${i === index}">`
        + `<span class="link-pick-title">${esc(c.title)}</span>${c.closed ? '<span class="link-pick-tag">Archive</span>' : ""}</button>`).join("")
      : `<div class="link-pick-empty">${circle(fromId) ? "No note of this circle matches" : "No note matches"}</div>`;
  };
  const place = pos => {
    if (!box) return;
    if (!pos) return close();
    const vv = window.visualViewport;
    const width = Math.min(320, window.innerWidth - 16);
    box.style.width = width + "px";
    box.style.left = Math.max(8, Math.min(pos.left, window.innerWidth - width - 8)) + "px";
    // Below the line, or above it when the keyboard / toolbar leaves no room below.
    const bar = document.getElementById("toolbar");
    const bottom = bar && !bar.hidden ? bar.getBoundingClientRect().top : (vv ? vv.offsetTop + vv.height : window.innerHeight);
    const below = bottom - pos.bottom - 8;
    if (below >= Math.min(box.offsetHeight, 160)) { box.style.top = pos.bottom + 4 + "px"; box.style.bottom = ""; box.style.maxHeight = below + "px"; }
    else { box.style.top = ""; box.style.bottom = window.innerHeight - pos.top + 4 + "px"; box.style.maxHeight = Math.max(120, pos.top - 8) + "px"; }
  };
  const refresh = v => {
    view = v;
    const sel = v.state.selection.main;
    const line = v.state.doc.lineAt(sel.head);
    const t = sel.empty && v.hasFocus && linkTrigger(line.text.slice(0, sel.head - line.from));
    if (!t) { dismissed = -1; return close(); }
    if (line.from + t.from === dismissed) return close();   // Esc closed the picker for this [[
    const query = t.query;
    const changed = !trigger || trigger.query !== query;
    trigger = { at: line.from + t.from, query };
    if (changed) index = 0;
    items = linkCandidates(allNotes(), { from: fromId, circle, query });
    if (!box) {
      box = document.createElement("div");
      box.className = "link-picker keep-editing";
      box.setAttribute("role", "listbox");
      box.setAttribute("aria-label", "Link to a note");
      // Keep the editor's focus (and the on-screen keyboard).
      box.addEventListener("pointerdown", e => e.preventDefault());
      box.addEventListener("click", e => { const b = e.target.closest(".link-pick"); if (b) choose(Number(b.dataset.i)); });
      document.body.append(box);
    }
    paint();
    v.requestMeasure({ key: box, read: m => (trigger ? m.coordsAtPos(trigger.at) : null), write: place });
  };
  const move = d => { if (!box || !items.length) return false; index = (index + d + items.length) % items.length; paint(); return true; };

  return [
    ViewPlugin.define(v => {
      view = v;
      return { update: u => { if (u.docChanged || u.selectionSet || u.focusChanged || u.geometryChanged) refresh(u.view); }, destroy: close };
    }),
    Prec.highest(keymap.of([
      { key: "ArrowDown", run: () => move(1) },
      { key: "ArrowUp", run: () => move(-1) },
      { key: "Enter", run: () => { if (!box || !items.length) return false; choose(index); return true; } },
      { key: "Tab", run: () => { if (!box || !items.length) return false; choose(index); return true; } },
      { key: "Escape", run: () => { if (!box) return false; dismissed = trigger.at; close(); return true; } },
    ])),
  ];
}

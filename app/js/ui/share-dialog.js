// The share dialog: pick the people a note (or several notes) is shared
// with. It lives in the Sync & sharing panel's container (sync-panel.js).
// A contact row is a tri-state checkbox: checked = every selected note is
// shared with them, mixed = only some are, unchecked = none. Saving moves
// each note into the file of its new set of people (docs/sync-and-sharing.md
// → "Files").
import { state, circleOf, shareNotes, removeNotes, leaveNotes, contacts } from "../store.js";
import { circleKey, circleLabel, shareState } from "../core/sharing.js";
import { h, text, button } from "./dom.js";
import { openPanel, registerPage, closePanel, go, setStack } from "./sync-panel.js";
import { showSnackbar } from "./snackbar.js";
import { avatarHtml, nameOf } from "./people.js";
import { icon } from "./icons.js";

const noun = n => n === 1 ? "Note" : "Notes";

/** Opens the dialog for note ids. */
export function openShareDialog(ids) {
  if (!ids.length) return;
  const page = state.sync.enabled ? "share" : "shareOff";
  openPanel(page, { ids, states: initialStates(ids) });
}

function initialStates(ids) {
  const sets = ids.map(circleOf);
  return Object.fromEntries(contacts().map(c => [c.id, shareState(sets, c.id)]));
}

// The member ids each note ends up with: its own members, plus the contacts
// checked, minus the ones unchecked; "mixed" contacts stay as they are.
function resultingSets(ids, states) {
  return ids.map(id => {
    const members = circleOf(id).filter(m => states[m] !== "none");
    for (const [contactId, s] of Object.entries(states)) if (s === "all" && !members.includes(contactId)) members.push(contactId);
    return members;
  });
}

function save(data) {
  const { ids, states } = data;
  const sets = resultingSets(ids, states);
  const before = ids.map(id => circleKey(circleOf(id)));
  const changed = sets.some((m, i) => circleKey(m) !== before[i]);
  closePanel();
  if (!changed) return;
  const undos = [];
  if (new Set(sets.map(circleKey)).size === 1) undos.push(shareNotes(ids, sets[0]));
  else ids.forEach((id, i) => undos.push(shareNotes([id], sets[i])));
  const undo = () => undos.reverse().forEach(fn => fn());
  const same = new Set(sets.map(circleKey)).size === 1;
  const message = !same ? "Sharing updated"
    : sets[0].length ? `Shared with ${circleLabel(sets[0].map(nameOf))}`
    : ids.length === 1 ? "Note is private again" : "Notes are private again";
  showSnackbar(message, undo);
}

function leave(data) {
  // Real sync: the notes are marked as left and a remaining member moves them on; the sample just removes them.
  const undo = state.sync.simulated ? removeNotes(data.ids) : leaveNotes(data.ids);
  closePanel();
  showSnackbar(data.ids.length === 1 ? "You left the note" : "You left the notes", undo);
}

// Tri-state checkbox: a tap on "mixed" or unchecked checks it, on checked clears it.
const MARK = { all: icon("check", "icon box-mark"), some: icon("minus", "icon box-mark"), none: "" };

// A contact row: tapping anywhere toggles the checkbox.
function contactRow(c, data, onToggle) {
  const box = h("button", { class: "check-box", type: "button", role: "checkbox", "aria-label": `Share with ${c.name}` });
  const row = h("div", {
    class: "share-row",
    onclick: () => {
      data.states[c.id] = data.states[c.id] === "all" ? "none" : "all";
      paint(box, data.states[c.id]);
      onToggle();
    },
  },
  h("span", { html: avatarHtml(c.id) }),
  h("span", { class: "row-text" }, h("span", { class: "row-title" }, c.name)),
  box);
  paint(box, data.states[c.id]);
  return row;
}

function paint(box, s) {
  box.setAttribute("aria-checked", s === "some" ? "mixed" : String(s === "all"));
  box.dataset.state = s;
  box.innerHTML = MARK[s];
}

// A notice under the list for each checked contact who isn't verified (backlog #4): the hint shows where
// it matters, the list stays calm (decided 2026-10-14 over a label or an avatar badge in every row).
function notices(data) {
  const el = h("div", { class: "share-notices" });
  const update = () => el.replaceChildren(...contacts().filter(c => !c.pending && !c.verified && data.states[c.id] !== "none").map(c =>
    h("div", { class: "share-notice" },
      h("span", { class: "notice-icon", html: icon("protect") }),
      h("span", { class: "row-text" }, h("span", { class: "row-title" }, `${c.name} isn't verified`),
        h("span", { class: "row-sub" }, "Added by link. Check that it's really them.")),
      button("Verify", "outline", () => go("verifyContact", { id: c.id, tab: "code" })))));
  update();
  return { el, update };
}

const leavable = ids => {
  const keys = new Set(ids.map(id => circleKey(circleOf(id))));
  return keys.size === 1 && !keys.has("");
};

registerPage("share", {
  title: data => data.ids.length === 1 ? "Share note" : `Share ${data.ids.length} notes`,
  render: data => {
    // A contact added from here comes back checked, unless the request is still open.
    data.onContactAdded = c => { if (!c.pending) data.states[c.id] = "all"; };
    const notice = notices(data);
    return [
      text("Only the people you pick can read it. Everyone you share with can edit, close and share it too."),
      contacts().some(c => !c.pending)
        ? h("div", { class: "sheet-card share-list", role: "group", "aria-label": "Contacts" }, contacts().filter(c => !c.pending).map(c => contactRow(c, data, notice.update)))
        : null,
      notice.el,
      h("button", { class: "share-row add", type: "button", onclick: () => go("addContact", { mode: "scan" }) },
        h("span", { class: "row-icon", html: icon("plus") }), h("span", { class: "row-title" }, "Add contact")),
      leavable(data.ids) ? h("div", { class: "button-row" }, button("Leave", "danger", () => leave(data))) : null,
    ];
  },
  footer: data => [
    h("div", { class: "foot-actions" }, button("Cancel", "", () => closePanel()), button("Save", "primary", () => save(data))),
  ],
});

registerPage("shareOff", {
  title: data => data.ids.length === 1 ? "Share note" : `Share ${data.ids.length} notes`,
  render: () => [
    h("div", { class: "hero", html: icon("sync") }),
    text("Sharing needs sync. Turn it on to share notes with your contacts."),
  ],
  footer: () => [
    h("div", { class: "foot-actions" },
      button("Cancel", "", () => closePanel()),
      button("Turn on sync", "primary", () => setStack([["off"], ["name"]]))),
  ],
});

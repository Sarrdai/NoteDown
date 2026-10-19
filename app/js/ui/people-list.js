// The people overview (backlog #23): next to the contents, a list of the
// circles the user shares with — everything, the private notes, each
// contact on their own and each group. Picking entries filters the note
// list to those circles; a long-press starts picking several
// (ui/filter-pick.js). The groups a contact is in show on the contact's page
// (ui/verify-contact.js). The server owner's news are pinned on top, with a
// badge while posts are new or updated, and are picked only on their own. The user's folder sources
// (core/folder-source.js) follow Private, each filtering to the notes read from its folder.
// Without contacts it still shows, with a hint and Add contact, so the
// feature is there to be found.
import { circleEntries } from "../core/sharing.js";
import { toggleCircle } from "../core/filters.js";
import { NEWS, freshCount } from "../core/news.js";
import { sourceKey, sourceIdOf } from "../core/folder-source.js";
import { state, setUi, sharedCircles, contacts, newsNotes, sources } from "../store.js";
import { avatarHtml, avatarStackHtml, membersLabel, nameOf, esc } from "./people.js";
import { icon } from "./icons.js";
import { h, button } from "./dom.js";
import { wirePick, checkHtml, pickBar } from "./filter-pick.js";

const $ = id => document.getElementById(id);
let onPicked = () => {};
let onAddContact = () => {};

/** Label of a circle key: "All notes", "Private", "News", a folder source's name, "Lea", "Lea & Tom". */
export function circleName(key, members = key ? key.split("+") : []) {
  const source = sourceIdOf(key);
  if (source) return sources().find(s => s.id === source)?.name || "Folder";
  return key === null ? "All notes" : key === "" ? "Private" : key === NEWS ? "News" : membersLabel(members);
}

/** The leading icon or avatar(s) of a circle key, as HTML. */
export function circleLeadHtml(key, cls = "") {
  if (sourceIdOf(key)) return icon("folder");
  const members = key && key !== NEWS ? key.split("+") : [];
  return key === null ? icon("notes") : key === NEWS ? icon("news") : !members.length ? icon("lock")
    : members.length === 1 ? avatarHtml(members[0], cls) : avatarStackHtml(members);
}

/** The badge with the number of new or updated news posts (none for 0). */
export function newsBadgeHtml(n) {
  return n ? `<span class="news-badge" aria-label="${n} new">${n}</span>` : "";
}

/** Renders the overview; `count(key)` gives a circle's notes in the current view. */
export function renderPeople(count) {
  const news = newsNotes();
  const circles = circleEntries(contacts(), sharedCircles(), nameOf);
  const folders = [...sources()].sort((a, b) => a.name.localeCompare(b.name)).map(s => ({ key: sourceKey(s.id), kind: "source", members: [] }));
  const at = circles.findIndex(e => e.key === "") + 1;
  const entries = [...(news.length ? [{ key: NEWS, kind: "news", members: [] }] : []), ...circles.slice(0, at), ...folders, ...circles.slice(at)];
  const picked = state.circles;
  $("peopleList").replaceChildren(...[pickBar("people", picked.length)].filter(Boolean), ...entries.map(e => {
    const b = document.createElement("button");
    const n = count(e.key);
    const on = e.key === null ? !picked.length : picked.includes(e.key);
    b.className = `people-entry ${e.kind}` + (on ? " active" : "") + (n ? "" : " none");
    b.dataset.key = e.key ?? "*";
    const badge = e.kind === "news" ? newsBadgeHtml(freshCount(news)) : "";
    b.innerHTML = `<span class="people-lead">${circleLeadHtml(e.key)}</span><span class="people-name">${esc(circleName(e.key, e.members))}</span>${badge}<span class="people-count">${n}</span>`
      + (e.kind === "all" ? "" : checkHtml("people", on));
    if (on) b.setAttribute("aria-current", "true");
    return b;
  }), ...(contacts().length ? [] : [h("div", { class: "people-empty" },
    h("p", {}, "No contacts yet. Add one to share notes with them."),
    button("Add contact", "outline", () => onAddContact()))]));
}

const keyOf = el => el.dataset.key === "*" ? null : el.dataset.key;

function setCircles(circles) {
  setUi({ circles, topId: null });
  window.scrollTo(0, 0);
}

/** Shows only this circle's notes (null: all notes). */
export function pickCircle(key) {
  setCircles(key === null ? [] : [key]);
  onPicked(true);
}

/** Adds the circle to the filter or takes it out (null: all notes). */
export function toggleCircleFilter(key) {
  setCircles(toggleCircle(state.circles, key, NEWS));
}

export function initPeople({ onPick, onAdd }) {
  onPicked = onPick;
  onAddContact = onAdd;
  wirePick($("peopleList"), {
    tab: "people",
    selector: ".people-entry",
    isAll: el => keyOf(el) === null,
    single: el => setCircles(keyOf(el) === null ? [] : [keyOf(el)]),
    toggle: el => toggleCircleFilter(keyOf(el)),
    picked: el => state.circles.includes(keyOf(el)),
    count: () => state.circles.length,
    closes: close => onPicked(close),
  });
}

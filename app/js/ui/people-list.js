// The people overview (backlog #23): next to the contents, a list of the
// circles the user shares with — everything, the private notes, each
// contact on their own and each group. Picking one filters the note list to
// that circle; a long-press (or right-click) on a contact lists the groups
// they are in, to jump there. The server owner's news are pinned on top,
// with a badge while posts are new or updated.
import { circleEntries, groupsWith, circleKey } from "../core/sharing.js";
import { NEWS, freshCount } from "../core/news.js";
import { state, setUi, sharedCircles, activeCircle, contacts, newsNotes } from "../store.js";
import { avatarHtml, avatarStackHtml, membersLabel, nameOf, esc } from "./people.js";
import { openMenu } from "./menu.js";
import { icon } from "./icons.js";

const HOLD_MS = 450;
const MOVE_TOLERANCE = 10;
const $ = id => document.getElementById(id);
let press = null;
let swallowClick = false;
let onPicked = () => {};

/** Label of a circle key: "All notes", "Private", "Lea", "Lea & Tom". */
export function circleName(key, members = key ? key.split("+") : []) {
  return key === null ? "All notes" : key === "" ? "Private" : key === NEWS ? "News" : membersLabel(members);
}

function leading(e) {
  const inner = e.kind === "news" ? icon("news") : e.kind === "all" ? icon("notes") : e.kind === "private" ? icon("lock")
    : e.kind === "contact" ? avatarHtml(e.members[0]) : avatarStackHtml(e.members);
  return `<span class="people-lead">${inner}</span>`;
}

/** The badge with the number of new or updated news posts (none for 0). */
export function newsBadgeHtml(n) {
  return n ? `<span class="news-badge" aria-label="${n} new">${n}</span>` : "";
}

/** Renders the overview; `count(key)` gives a circle's notes in the current view. */
export function renderPeople(count) {
  const news = newsNotes();
  const entries = [...(news.length ? [{ key: NEWS, kind: "news", members: [] }] : []), ...circleEntries(contacts(), sharedCircles(), nameOf)];
  const active = activeCircle();
  $("peopleList").replaceChildren(...entries.map(e => {
    const b = document.createElement("button");
    const n = count(e.key);
    b.className = `people-entry ${e.kind}` + (e.key === active ? " active" : "") + (n ? "" : " none");
    b.dataset.key = e.key ?? "*";
    const badge = e.kind === "news" ? newsBadgeHtml(freshCount(news)) : "";
    b.innerHTML = `${leading(e)}<span class="people-name">${esc(circleName(e.key, e.members))}</span>${badge}<span class="people-count">${n}</span>`;
    if (e.key === active) b.setAttribute("aria-current", "true");
    return b;
  }));
}

const keyOf = el => el.dataset.key === "*" ? null : el.dataset.key;

export function pickCircle(key) {
  setUi({ circle: key, topId: null });
  window.scrollTo(0, 0);
  onPicked(key);
}

// The groups a contact is in, as a menu at the entry.
function groupsMenu(el) {
  const id = keyOf(el);
  const groups = groupsWith(id, sharedCircles());
  openMenu(el, [
    { section: `Groups with ${nameOf(id)}` },
    ...(groups.length
      ? groups.map(m => ({ label: membersLabel([...m].sort()), onSelect: () => pickCircle(circleKey(m)) }))
      : [{ label: "Not in any group yet", disabled: true, onSelect: () => {} }]),
  ]);
}

export function initPeople({ onPick }) {
  onPicked = onPick;
  const list = $("peopleList");
  list.addEventListener("pointerdown", e => {
    swallowClick = false;
    const el = e.target.closest(".people-entry.contact");
    if (!el || e.button !== 0) return;
    press = { el, x: e.clientX, y: e.clientY, timer: setTimeout(onHold, HOLD_MS) };
  });
  list.addEventListener("pointermove", e => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE) cancelPress();
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) list.addEventListener(type, cancelPress);
  list.addEventListener("contextmenu", e => {
    const el = e.target.closest(".people-entry");
    if (!el) return;
    e.preventDefault();
    if (el.classList.contains("contact") && !swallowClick) groupsMenu(el);
  });
  list.addEventListener("click", e => {
    const el = e.target.closest(".people-entry");
    if (!el) return;
    if (swallowClick) { swallowClick = false; return; }
    pickCircle(keyOf(el));
  });
}

function cancelPress() {
  if (!press) return;
  clearTimeout(press.timer);
  press = null;
}

function onHold() {
  const { el } = press;
  press = null;
  swallowClick = true; // the click that follows the release
  try { navigator.vibrate?.(15); } catch { /* not allowed */ }
  groupsMenu(el);
}

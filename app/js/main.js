// NoteDown prototype: wires the store to the views.
import { viewNotes, inViewOf, doneOn, SORT_KEYS, DIR_LABELS, customSplit, rearrange, arrangeRows, orderSections, sectionTitle, TRASH_DAYS, PILE_ID } from "./core/query.js";
import { pileState, tidyConfig, tidyCounted } from "./core/tidy.js";
import { circleKey, circleEntries } from "./core/sharing.js";
import { state, note, load, followOtherTabs, subscribe, updateSettings, setUi, addNote, purgeNotes, removeNotes, replaceFiles, setSync, allNotes, trashNotes, purgeExpiredTrash, circleOf, circleNotes, activeCircle, customOrder, setCustomOrder, circleOrder, setCircleOrder, sharedFiles, newsNotes, contacts, sharedCircles } from "./store.js";
import { NEWS, freshCount } from "./core/news.js";
import { trackNews } from "./ui/news-seen.js";
import { parseNotesFile } from "./core/notes-file.js";
import { welcomeNotes, detachedFile } from "./core/sync-state.js";
import { loadSampleState } from "./sample.js";
import { initSyncSim, setOffline } from "./sync-sim.js";
import { initSync } from "./sync/client.js";
import { initSyncPanel, openSyncPanel, closePanel, statusText, syncOnRequest, openInvite, openLinkPage } from "./ui/sync-panel.js";
import { initSyncNotice } from "./ui/sync-notice.js";
import "./ui/history.js";
import { initInviteLinks, webAddress } from "./invite-link.js";
import { initQuickCapture } from "./quick-capture.js";
import { initContactRequests, simulateRequest } from "./ui/contact-requests.js";
import "./ui/verify-contact.js";
import { initPullRefresh } from "./ui/pull-refresh.js";
import { initViewSwipe } from "./ui/view-swipe.js";
import { pushEntry, leaveEntry, afterLeave } from "./ui/dom.js";
import { renderList, reorderList, listItems, patchNote, startEdit, endEdit, flashNote, onEditEnded, collapseNote } from "./ui/note-list.js";
import { renderToc, tocItems, initToc, setTocOpen } from "./ui/toc.js";
import { renderWatchBar, initWatchBar } from "./ui/watch-bar.js";
import { initSearchHits } from "./ui/search-hits.js";
import { initSearchSuggest } from "./ui/search-suggest.js";
import { labelCounts, labelKey } from "./core/labels.js";
import { headings } from "./core/markdown.js";
import { nameOf } from "./ui/people.js";
import { renderPeople, initPeople, circleName, circleLeadHtml, pickCircle, toggleCircleFilter, newsBadgeHtml } from "./ui/people-list.js";
import { renderLabels, initLabels, toggleLabelFilter } from "./ui/labels.js";
import { setPicking } from "./ui/filter-pick.js";
import { hasAnyLabel } from "./core/filters.js";
import { initToolbar } from "./ui/toolbar.js";
import { initRecorder } from "./ui/recorder.js";
import { initSelection, syncSelection, endSelection, purgeSelected } from "./ui/selection.js";
import { initDragDrop } from "./ui/drag-drop.js";
import { openMenu, initMenu, closeMenu } from "./ui/menu.js";
import { hideSnackbar, showSnackbar } from "./ui/snackbar.js";
import { initConfirm, openConfirm } from "./ui/confirm.js";
import { initArrange, openArrange } from "./ui/arrange.js";
import { initMoveTo } from "./ui/move-to.js";
import { initReminders } from "./ui/reminders.js";
import { openDue } from "./ui/due.js";
import { dueItems, dueNowCount } from "./core/due-list.js";
import { initAppLock } from "./ui/app-lock.js";
import { initFolderSources } from "./ui/folder-sources.js";
import { isNativeApp, privacyPlugin } from "./platform.js";
import { initExport, openExport } from "./ui/export.js";
import { initStorageHint, showHintAgain } from "./ui/storage-hint.js";
import { initExternal } from "./ui/external.js";
import { initCompare } from "./ui/compare.js";
import { openSettings, FLAVORS } from "./ui/settings.js";
import { setAppInfo } from "./app-info.js";
import { exportFileName } from "./core/export.js";
import { today } from "./ui/format.js";
import { icon } from "./ui/icons.js";
import { refOf } from "./core/note-ref.js";

const $ = id => document.getElementById(id);
const app = $("app");
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

const DEFAULT_DIR = { modified: "desc", created: "desc", closed: "desc", deleted: "desc", due: "asc", title: "asc", custom: "asc" };
const TITLES = { open: "Notes", closed: "Archive", trash: "Trash" };


const phone = window.matchMedia("(max-width: 599px)");

// "Shared shelves" (#25) exists only in the view of a circle with people;
// elsewhere a view set to it shows the user's own custom order.
// A circle key starting with "@" is no circle of people: the news, a folder source (core/folder-source.js).
const peopleKey = key => (key && !key.startsWith("@") ? key : null);
const sharedCircle = () => peopleKey(activeCircle());
function sortOf(view = state.view) {
  const sort = state.settings.sort[view];
  return SORT_KEYS[sort.key].circleOnly && !sharedCircle() ? { key: "custom", dir: "asc" } : sort;
}
const orderIds = (view = state.view) => sortOf(view).key === "shared" ? circleOrder(sharedCircle()) : customOrder();
const inView = (notes, view = state.view, search = state.search) => viewNotes(notes, { status: view, search, sort: sortOf(view), order: orderIds(view) });
// The notes the list shows before view and search: the picked circles, then the picked labels,
// then permanent ones only when that filter is on.
const byLabel = notes => notes.filter(n => hasAnyLabel(n.body, state.labels));
const byPermanent = notes => state.permanent ? notes.filter(n => n.status === "permanent") : notes;
const withLabel = notes => byPermanent(byLabel(notes));
const inCircles = () => state.circles.length ? state.circles.flatMap(k => circleNotes(k)) : circleNotes(null);
const listed = () => withLabel(inCircles());
const isCustom = (view = state.view) => !!SORT_KEYS[sortOf(view).key].custom;

// Where a new note goes: the circle the list is filtered to, else private.
// From the news, which take no notes, the list goes back to all notes first; from a folder source the note
// is private (only the folder adds to a source) and the list goes back to all notes too, so it shows.
// With several circles picked, + asks which of them (newNote) and dictation
// is blocked (dictationBlocked).
function newNoteMembers(key = activeCircle()) {
  if (state.circles.includes(NEWS) || (key && !peopleKey(key))) setUi({ circles: [] }, "silent");
  return peopleKey(key) ? key.split("+") : [];
}
const dictationBlocked = () => state.circles.length > 1 ? "To dictate, show one circle only" : null;

// A new note kept on top shows even when the filters leave it out (a label
// filter, permanent only): it must open visibly and editable.
function currentNotes() {
  const notes = inView(listed());
  const i = notes.findIndex(n => refOf(n) === state.topId);
  if (i > 0) notes.unshift(...notes.splice(i, 1));
  const top = i < 0 && state.topId && note(state.topId);
  if (top && inViewOf(top, state.view)) notes.unshift(top);
  return notes;
}

// The notes in the order the list shows them right now: the contents follow
// it while a note is edited, when the list doesn't reorder (sortIn).
let shownNotes = [];
const stillShown = () => shownNotes.filter(n => note(refOf(n)));

// The sync status: a cloud icon in the top bar while sync is on.
const SYNC_ICONS = { synced: "cloudCheck", syncing: "cloudSync", offline: "cloudOff", error: "cloudOff" };

function renderSyncStatus() {
  const btn = $("syncBtn");
  if (!state.sync.enabled) {
    btn.dataset.status = "";
    btn.innerHTML = icon("cloud");
    btn.setAttribute("aria-label", "Sync & sharing");
    btn.title = "Sync & sharing";
    return;
  }
  const { status } = state.sync;
  if (btn.dataset.status !== status) {
    // A round that transferred something ends with the check drawing itself in.
    btn.classList.toggle("just-synced", btn.dataset.status === "syncing" && status === "synced");
    btn.dataset.status = status;
    btn.innerHTML = icon(SYNC_ICONS[status]);
  }
  btn.setAttribute("aria-label", "Sync & sharing: " + statusText());
  btn.title = "Sync & sharing · " + statusText();
}

// The Due button: its badge counts the items overdue or due today (red when one is overdue), its ring fills
// with what was done today, planned or not — done ÷ (done + still due now); no ring on a day with neither.
function renderDueCount() {
  const items = dueItems(allNotes(), today());
  const now = dueNowCount(items, today());
  const done = doneOn(allNotes(), today());
  const badge = $("dueCount");
  badge.textContent = now;
  badge.classList.toggle("has", now > 0);
  badge.classList.toggle("overdue", items.some(it => it.day < today()));
  $("dueRing").classList.toggle("has", done + now > 0);
  const share = done + now ? Math.round(100 * done / (done + now)) : 0;
  $("dueRingDone").setAttribute("stroke-dasharray", `${share} 100`);
  $("dueRingDone").classList.toggle("empty", share === 0);
  const label = ["Due", now && `${now} now`, done && `${done} done today`].filter(Boolean).join(" · ");
  $("dueBtn").setAttribute("aria-label", label);
  $("dueBtn").title = label;
}

function render() {
  const s = state.settings;
  const flavor = s.flavor === "system" ? (systemDark.matches ? "mocha" : "latte") : s.flavor;
  document.documentElement.dataset.flavor = flavor;
  app.dataset.view = state.view;
  app.classList.toggle("has-search", state.search !== "");

  $("title").textContent = TITLES[state.view];
  const sort = sortOf();
  // Time to tidy up the Shelves' pile: a dot on the sort button, whatever the list is sorted by.
  const due = state.view === "open" && mainPile().level === "full";
  renderSortFab(sort, due);
  renderWatchBar();
  renderDueCount();
  $("viewBtn").setAttribute("aria-label", state.view === "open" ? "Archive" : "Notes");
  $("viewBtn").title = state.view === "open" ? "Archive" : "Notes";
  $("viewHint").hidden = state.view !== "trash";
  renderFab();
  if ($("searchInput").value !== state.search) $("searchInput").value = state.search;

  renderSyncStatus();
  fitTopbar();
  renderCircleFilter();
  const notes = currentNotes();
  shownNotes = notes;
  renderList(...listArgs(state.view, notes));
  trackNews();
  syncSelection(notes);
  renderToc(notes);
  const empty = $("empty");
  empty.hidden = notes.length > 0;
  empty.textContent = emptyText(state.view, state.search);
}

// The tiles of a view (a new note kept on top comes first, currentNotes) and,
// sorted by a custom order, its pile: the notes not sorted in yet, which come
// first under their header (core/query.js; a new note is one of them, on top of
// the pile), then the sections with their notes.
function tilesOf(view, notes) {
  if (!isCustom(view)) return { tiles: notes, pile: null, sectionOf: () => null };
  const isTop = n => refOf(n) === state.topId;
  const sorted = new Set(orderIds(view));
  const piled = notes.filter(n => !sorted.has(refOf(n)));
  const ids = new Set(piled.map(refOf));
  const collapsed = !state.search && state.settings.collapsedSections.includes(PILE_ID);
  const pile = { has: id => ids.has(id), top: state.topId, collapsed, ...pileLevel(view, piled) };
  return { tiles: notes, pile, sectionOf: sectionsOf(view, notes, isTop) };
}

// renderList's and reorderList's arguments for a view's notes.
function listArgs(view, notes) {
  const { tiles, pile, sectionOf } = tilesOf(view, notes);
  return [tiles, { pile, sectionOf, onArrange: arrange, onTogglePile: () => toggleSection(PILE_ID), onToggleSection: toggleSection }];
}

// How full a pile is (core/tidy.js): only in the main view, ignored circles' notes left out.
function pileLevel(view, piled) {
  if (view !== "open") return { level: null, count: piled.length };
  const notes = piled.filter(n => !n.news).map(n => ({ created: n.created, circle: circleKey(circleOf(refOf(n))) }));
  const t = state.settings.tidy;
  return { ...pileState(notes, k => tidyCounted(t, k), tidyConfig(t)), count: piled.length };
}

// The Shelves' pile in the main view with the current filters, whatever the list is sorted by.
function mainPile() {
  const sorted = new Set(orderIds("open"));
  return pileLevel("open", viewNotes(listed(), { status: "open", sort: { key: "modified", dir: "desc" } }).filter(n => !sorted.has(refOf(n))));
}

// A custom order's sections (#24): for a note, the section it is in with how
// many of `notes` that holds and whether it is folded on this device (never
// while searching, so every hit shows), or null. `outside` notes are in none.
function sectionsOf(view, notes, outside = () => false) {
  if (!isCustom(view)) return () => null;
  const of = orderSections(orderIds(view));
  const idOf = n => (!outside(n) && of.get(refOf(n))) || null;
  const counts = new Map();
  for (const n of notes) { const id = idOf(n); if (id) counts.set(id, (counts.get(id) || 0) + 1); }
  const folded = new Set(state.search ? [] : state.settings.collapsedSections);
  return n => { const id = idOf(n); return id && { id, title: sectionTitle(id), count: counts.get(id), collapsed: folded.has(id) }; };
}

// Ending the search (×, back, Esc) keeps the place the user is reading:
// the note with the current hit — or, scrolled away from it, the topmost
// note in view — stays where it is on the screen while the other notes
// come back around it, and flashes. A folded section (or pile) holding it
// unfolds. Back ends the search too: it has a history entry while a text is in.
function endSearch({ fromHistory = false } = {}) {
  const topbar = $("topbar").getBoundingClientRect().bottom;
  const onScreen = el => { const r = el.getBoundingClientRect(); return r.bottom > topbar && r.top < window.innerHeight; };
  const hit = $("list").querySelector("mark.hit.current");
  const anchor = (hit && onScreen(hit) ? hit.closest(".note") : null) || [...$("list").querySelectorAll(".note")].find(onScreen);
  const id = anchor?.dataset.id;
  const top = anchor?.getBoundingClientRect().top;
  app.classList.remove("searching");
  $("searchInput").blur();
  if (!fromHistory) leaveEntry("search");
  if (!state.search) return;
  setUi({ search: "", topId: null });
  if (!id) return;
  const find = () => $("list").querySelector(`.note[data-id="${CSS.escape(id)}"]`);
  if (!find() && isCustom()) toggleSection(orderSections(orderIds()).get(id) || PILE_ID);
  const el = find();
  if (!el) return;
  window.scrollBy(0, el.getBoundingClientRect().top - top);
  flashNote(id);
}

function toggleSection(id) {
  const folded = state.settings.collapsedSections;
  updateSettings({ collapsedSections: folded.includes(id) ? folded.filter(x => x !== id) : [...folded, id] });
}

function emptyText(view, search) {
  const circle = activeCircle();
  return search ? `No notes match “${search}”.`
    : state.permanent && !state.labels.length ? "No permanent notes here."
    : state.labels.length ? `No notes labelled ${state.labels.map(l => "#" + l).join(" or ")} here.`
    : view === "trash" ? "The trash is empty."
    : circle === NEWS ? (view === "open" ? "No news right now." : "No archived news.")
    : circle && view === "open" ? `Nothing shared with ${circleName(circle)} yet. Tap + to start.`
    : circle === "" && view === "open" ? "No private notes. Tap + to add one."
    : state.circles.length > 1 ? (view === "open" ? "No open notes in these circles." : "Nothing archived in these circles.")
    : view === "open" ? "No open notes. Tap + to add one." : "Nothing archived yet.";
}

// What moves in a view swipe (ui/view-swipe.js): the list column below the
// top bar, and the contents panel where it shows (the sidebar, the sheet):
// its list where that shows, else (the closed sheet) only its tint.
function swipeLanes() {
  const lanes = [{
    move: document.querySelector(".main"),
    rect: () => {
      const box = document.querySelector(".main").getBoundingClientRect();
      return { top: $("topbar").getBoundingClientRect().bottom, left: box.left, width: box.width };
    },
    preview: previewView,
  }];
  const panel = $("tocPanel"), toc = $("tocList");
  const listShows = toc.getClientRects().length && getComputedStyle(toc).visibility === "visible";
  if (panel.getClientRects().length) lanes.push({
    move: panel,   // the panel carries --swipe-x: the list moves by it, the background splits at it
    rect: () => { const r = (listShows ? toc : panel).getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height }; },
    preview: listShows ? view => { const l = document.createElement("div"); l.className = "toc-list"; l.append(...tocItems(inView(listed(), view, ""), "", view)); return [l]; } : null,
    peekClass: "toc-peek",
  });
  return lanes;
}

// The contents panel's tabs from left to right, each with its pane.
const PANEL_TABS = ["toc", "people", "labels"];
const tabPane = tab => $({ toc: "tocPane", people: "peoplePane", labels: "labelsPane" }[tab]);

// A swipe on the contents panel moves its pane; the neighbouring tab's pane
// moves in as a copy (all three are always rendered).
function tabLanes() {
  const pane = tabPane(state.panelTab);
  return [{
    move: pane,
    rect: () => { const r = pane.getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height }; },
    preview: tab => {
      const copy = tabPane(tab).cloneNode(true);
      for (const el of [copy, ...copy.querySelectorAll("[id]")]) el.removeAttribute("id");
      return [copy];
    },
    peekClass: "toc-peek tab-peek",
  }];
}

// What the other view will show once the swipe lands there (ui/view-swipe.js):
// the circle filter chip and the list as setView will render them, not live.
function previewView(view) {
  const notes = inView(listed(), view, "");
  const [tiles, options] = listArgs(view, notes);
  const nodes = [];
  if (!$("filterBar").hidden) nodes.push($("filterBar").cloneNode(true));
  const list = document.createElement("div");
  list.className = "list";
  list.append(...listItems(tiles, { ...options, onArrange: null, onTogglePile: null, onToggleSection: null, view }));
  nodes.push(list);
  if (!notes.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = emptyText(view, "");
    nodes.push(empty);
  }
  for (const node of nodes) for (const el of [node, ...node.querySelectorAll("[id]")]) el.removeAttribute("id");
  return nodes;
}

// Search suggestions (backlog #66, ui/search-suggest.js): what can still be
// picked in this view, counted without the search text.
function suggestData() {
  const unsearched = notes => inView(notes, state.view, "");
  const permanent = state.view === "open" && !state.permanent ? unsearched(byLabel(inCircles())).filter(n => n.status === "permanent").length : 0;
  const labels = labelCounts(unsearched(byPermanent(inCircles()))).filter(l => !state.labels.some(p => labelKey(p) === labelKey(l.name)));
  const circles = circleEntries(contacts(), sharedCircles(), nameOf).filter(e => e.key !== null && !state.circles.includes(e.key))
    .map(e => ({ key: e.key, name: circleName(e.key, e.members), count: unsearched(withLabel(circleNotes(e.key))).length }));
  const heads = unsearched(listed()).flatMap(n => headings(n.body).map(h => h.text));
  return { permanent, labels, circles, headings: heads };
}

// A picked filter becomes a chip and empties the field; a heading becomes the search text.
function pickSuggestion(s) {
  if (s.kind === "heading") return setUi({ search: s.value, topId: null });
  setUi({ search: "" }, "silent");
  if (s.kind === "permanent") { setUi({ permanent: true, topId: null }); window.scrollTo(0, 0); }
  else if (s.kind === "label") toggleLabelFilter(s.value);
  else toggleCircleFilter(s.value);
}

const suggestionLead = s => s.kind === "permanent" ? icon("permanent") : s.kind === "heading" ? icon("heading")
  : s.kind === "circle" ? circleLeadHtml(s.value, "small") : "";

// Picking several in a tab ends once its last entry is taken out (e.g. by a chip's ×).
function settlePicking() {
  if ((state.picking === "people" && !state.circles.length) || (state.picking === "labels" && !state.labels.length)) setPicking(null);
}

// The people and label overviews and the chips of the active filters above the list.
function renderCircleFilter() {
  const circle = activeCircle();
  app.dataset.tab = state.panelTab;
  for (const t of document.querySelectorAll(".panel-tab")) t.setAttribute("aria-selected", String(t.dataset.tab === app.dataset.tab));
  renderPeople(key => inView(withLabel(circleNotes(key))).length);
  renderLabels(inView(byPermanent(inCircles())), state.view === "open" ? inView(byLabel(inCircles())).filter(n => n.status === "permanent").length : null);
  // New or updated news: a badge on the People tab and on the phone's closed contents sheet.
  const fresh = freshCount(newsNotes());
  document.querySelector('.panel-tab[data-tab="people"]').innerHTML = "People" + newsBadgeHtml(fresh);
  $("tocHandle").innerHTML = newsBadgeHtml(fresh);
  // One chip with × per picked circle and label.
  const chip = (lead, name, clearLabel, onClear) => {
    const el = document.createElement("span");
    el.className = "filter-chip";
    el.innerHTML = `<span>${lead}<span></span></span><button class="icon-btn small" type="button">${icon("close")}</button>`;
    el.firstChild.lastChild.textContent = name;
    el.lastChild.setAttribute("aria-label", clearLabel);
    el.lastChild.addEventListener("click", onClear);
    return el;
  };
  // With several chips, a × in front of them clears all filters.
  const many = state.circles.length + state.labels.length + state.permanent > 1;
  const clearAll = many && Object.assign(document.createElement("button"), { className: "icon-btn small filter-clear-all", type: "button", innerHTML: icon("close") });
  if (clearAll) {
    clearAll.setAttribute("aria-label", "Clear all filters");
    clearAll.addEventListener("click", () => { setPicking(null); setUi({ circles: [], labels: [], permanent: false, topId: null }); });
  }
  $("filterBar").replaceChildren(...[clearAll].filter(Boolean),
    ...state.circles.map(k => chip(circleLeadHtml(k, "small"), circleName(k), `Stop showing ${circleName(k)}`, () => { toggleCircleFilter(k); settlePicking(); })),
    ...state.labels.map(l => chip("", "#" + l, `Stop showing #${l}`, () => { toggleLabelFilter(l); settlePicking(); })),
    ...(state.permanent ? [chip(icon("permanent"), "Permanent", "Stop showing permanent notes only", () => setUi({ permanent: false, topId: null }))] : []));
  $("filterBar").hidden = !state.circles.length && !state.labels.length && !state.permanent;
}

subscribe(kind => {
  if (kind === "sync") { renderSyncStatus(); return fitTopbar(); }   // the sync panel follows these itself
  if (kind.startsWith("note:")) {
    patchNote(kind.slice(5));
    renderToc(stillShown());
    renderWatchBar();
    renderDueCount();   // a ticked task or a changed date moves the Due button's count and ring
  } else if (!state.editingId) {
    render();
  }
});

// When an edit ends the note sorts in at once, and sorted by due date a new
// due date does so even while it is edited: the note stays where it is on the
// screen and the list moves around it. A note the filters leave out now folds
// away first. Changes skipped while editing (structure events) come in too.
function sortIn(id) {
  if (state.editingId && state.editingId !== id) return;
  const notes = currentNotes();
  const gone = id && !state.editingId && !notes.some(n => refOf(n) === id) && document.querySelector(`#list .note[data-id="${id}"]`);
  const place = () => {
    const now = currentNotes();
    shownNotes = now;
    const [tiles, options] = listArgs(state.view, now);
    reorderList(tiles, { keepId: gone ? state.editingId : (state.editingId || id), ...options });
    renderToc(now);
    syncSelection(now);
    renderCircleFilter();
    $("empty").hidden = now.length > 0;
    $("empty").textContent = emptyText(state.view, state.search);
  };
  if (!gone) return place();
  collapseNote(id).then(place);
  showSnackbar("Note hidden by the filter");
}
const sortInByDue = id => { if (sortOf().key === "due") sortIn(id); };
onEditEnded(sortIn);

// The trash lies right of the archive (ui/view-swipe.js): the back key leads
// from it to the archive, so it sits on a history entry of its own.
let trashDepth = 0;
const enterTrash = () => pushEntry({ trash: true }, depth => { trashDepth = depth; });

function setView(view, { fromHistory = false } = {}) {
  if (state.view === view) return;
  endSelection();
  hideSnackbar();
  leaveEntry("search");   // a view change ends the search, and with it its back step
  if (state.view === "trash" && !fromHistory) afterLeave(() => leaveEntry("trash"));
  if (view === "trash") enterTrash();
  setUi({ view, search: "", topId: null });
  app.classList.remove("searching");
  window.scrollTo(0, 0);
  $("tocList").scrollTop = 0;
}

// With several circles picked, + first asks which of them the note goes to.
function newNote() {
  endSelection();
  const circles = state.circles;
  if (circles.length > 1 && state.view === "open") return openMenu($("fab"), [
    { section: "New note in" },
    ...circles.map(k => ({ label: circleName(k), lead: circleLeadHtml(k, "small"), onSelect: () => createNote(k) })),
  ]);
  createNote();
}

function createNote(key) {
  if (state.view !== "open") setView("open");
  if (state.search) setUi({ search: "" }, "silent");
  const n = addNote("", newNoteMembers(key));
  state.topId = refOf(n);
  render();
  window.scrollTo(0, 0);
  startEdit(refOf(n));
}

// Quick capture from outside the app (app shortcuts, Quick Settings tile): the main view with nothing on top,
// then what + does there — a tap (new note) or a hold (dictation, hands-free as no finger holds it).
let recorder = null;
function quickCapture() {
  closeMenu();
  closePanel();
  setTocOpen(false);
  endSelection();
  if (state.view !== "open") setView("open");
}
function quickNewNote() {
  quickCapture();
  newNote();
}
function quickDictate() {
  quickCapture();
  if (state.editingId) endEdit();
  recorder.dictate();
}

// A dictated note: no heading, the transcript is its text.
function addDictatedNote(text) {
  if (state.view !== "open") setView("open");
  if (state.search) setUi({ search: "" }, "silent");
  const n = addNote(text, newNoteMembers());
  state.topId = refOf(n);
  render();
  window.scrollTo(0, 0);
  flashNote(refOf(n));
  showSnackbar("Dictated note added", () => purgeNotes([refOf(n)]));
}

// A merged note (or one made from moved sections) appears at the top of the list.
function onMerged(n, undo, message) {
  setTocOpen(false);
  state.topId = refOf(n);
  render();
  window.scrollTo(0, 0);
  flashNote(refOf(n));
  showSnackbar(message, undo);
}

// After Move to…: the target note comes into view and flashes.
function onMoved(id, undo, message) {
  showNote(id);
  showSnackbar(message, undo);
}

// The arrange dialog over the notes the list shows: the user's own custom
// order, or the shared order of the circle in view.
function arrange() {
  const shown = inView(listed());
  const key = sortOf().key === "shared" ? sharedCircle() : null;
  const { unsorted } = customSplit(shown, orderIds());
  const sorted = arrangeRows(shown, orderIds());
  const next = ids => rearrange(orderIds(), shown.map(n => refOf(n)), ids);
  openArrange(key ? {
    view: state.view,
    title: "Shared shelves", hint: `You and ${circleName(key)} see and can change these shelves.`, sorted, unsorted,
    save: ids => showSnackbar("Shared shelves saved", setCircleOrder(key, next(ids))),
  } : {
    view: state.view,
    sorted, unsorted,
    save: ids => showSnackbar("Shelves saved", setCustomOrder(next(ids))),
  });
}

// The floating sort button above the + (decided 2026-10-19 over beside / below the +
// and the top bar's sort button; user request: sorting is a core feature): an arrow
// for the direction (up ascending, down descending; Shelves show a shelf) and the
// sort's short name; a tap opens the sort menu (Shelves: Tidy up… / Arrange… in it).
// On the phone the open contents sheet carries the same button above its level
// stepper, as the sheet covers the floating one.
function renderSortFab(sort, due) {
  const { label, short, custom } = SORT_KEYS[sort.key];
  const dir = custom ? "" : (DIR_LABELS[sort.key] || DIR_LABELS.default)[sort.dir === "desc" ? 1 : 0];
  const text = "Sort: " + label + (dir ? ", " + dir : "") + (due ? " · time to tidy up" : "");
  const lead = custom ? "shelf" : sort.dir === "desc" ? "arrowDown" : "arrowUp";
  for (const b of [$("sortFab"), $("tocSort")]) {
    b.innerHTML = icon(lead) + `<span class="sort-fab-label"></span>`;
    b.querySelector(".sort-fab-label").textContent = short;
    b.classList.toggle("tidy-due", due);
    b.setAttribute("aria-label", text);
    b.title = text;
  }
}

function sortMenu(anchor = $("sortFab")) {
  const sort = sortOf();
  const keys = Object.entries(SORT_KEYS).filter(([, v]) => (!v.views || v.views.includes(state.view)) && (!v.circleOnly || sharedCircle()));
  const dirs = DIR_LABELS[sort.key] || DIR_LABELS.default;
  // A sort change ends a new note's place on top, like a view or search change.
  const reorder = patch => { state.topId = null; updateSettings(patch); };
  const setSort = next => reorder({ sort: { ...state.settings.sort, [state.view]: next } });
  openMenu(anchor, [
    { section: "Sort by" },
    ...keys.map(([key, v]) => ({ label: v.label, checked: sort.key === key, onSelect: () => setSort({ key, dir: DEFAULT_DIR[key] }) })),
    { separator: true },
    // A custom order has no direction; it is arranged instead (named like the pile header's link).
    ...(SORT_KEYS[sort.key].custom ? [{ label: customSplit(inView(listed()), orderIds()).unsorted.length ? "Tidy up…" : "Arrange…", onSelect: arrange }] : [
      { label: dirs[1], checked: sort.dir === "desc", onSelect: () => setSort({ ...sort, dir: "desc" }) },
      { label: dirs[0], checked: sort.dir === "asc", onSelect: () => setSort({ ...sort, dir: "asc" }) },
    ]),
  ]);
}

// The archive's bin button (renderFab): moves every closed note into the trash; shared notes only when
// ticked, as they go for everyone in their circle.
function emptyArchive() {
  const closed = allNotes().filter(n => n.status === "closed");
  const shared = closed.filter(n => circleOf(refOf(n)).length);
  const own = closed.length - shared.length;
  const notes = n => n === 1 ? "1 note" : `${n} notes`;
  const ids = withShared => closed.filter(n => withShared || !circleOf(refOf(n)).length).map(n => refOf(n));
  openConfirm({
    title: "Empty archive?",
    text: (own ? `Moves ${notes(own)} to the trash.` : "No private notes to move.") + ` The trash keeps them for ${TRASH_DAYS} days.`,
    check: shared.length ? {
      label: `Also delete ${notes(shared.length)} shared with others`,
      warning: shared.length === 1 ? "It is deleted for everyone it is shared with and waits in everyone's trash." : "They are deleted for everyone they are shared with and wait in everyone's trash.",
    } : null,
    okLabel: withShared => ids(withShared).length ? `Move ${ids(withShared).length}` : null,
    onConfirm: withShared => {
      const del = ids(withShared);
      showSnackbar(del.length === 1 ? "Note moved to trash" : `${del.length} notes moved to trash`, removeNotes(del));
    },
  });
}

// The first start holds only the welcome notes (app/welcome.md), sync off.
async function loadWelcome() {
  const text = await (await fetch(new URL("../welcome.md", import.meta.url))).text();
  const file = parseNotesFile("");
  file.notes.push(...welcomeNotes(text));
  replaceFiles({ file });
}

// The top bar's actions, left to right (search before them, ⋮ after them; Export
// lives under ⋮, sort floats above the +). What doesn't fit moves under ⋮ in
// FOLD_ORDER — Due first, the view button last, so the switch between the views
// stays in reach; on the desktop the search gives up its centered place and
// narrows before that.
const ACTIONS = [
  { id: "syncBtn", menu: () => ({ label: "Sync & sharing…", icon: state.sync.enabled ? SYNC_ICONS[state.sync.status] : "cloud", onSelect: openSyncPanel }) },
  { id: "viewBtn", menu: () => state.view === "open"
    ? { label: "Archive", icon: "archive", onSelect: () => setView("closed") }
    : { label: "Notes", icon: "notes", onSelect: () => setView("open") } },
  { id: "dueBtn", menu: () => ({ label: "Due" + (dueNowCount(dueItems(allNotes(), today()), today()) ? ` (${dueNowCount(dueItems(allNotes(), today()), today())} now)` : ""), icon: "calendar", onSelect: openDue }) },
];
const FOLD_ORDER = ["dueBtn", "syncBtn", "viewBtn"];
const wide = window.matchMedia("(min-width: 1024px)");

function fitTopbar() {
  const bar = $("topbar");
  const title = $("title");
  const search = $("search");
  for (const a of ACTIONS) { $(a.id).hidden = false; delete $(a.id).dataset.folded; }
  search.classList.toggle("centered", wide.matches);
  // Too tight: the title is cut, the buttons run out of the bar, or (desktop)
  // into the centered search.
  const tight = () => title.scrollWidth > title.clientWidth + 1
    || $("moreBtn").getBoundingClientRect().right > bar.getBoundingClientRect().right + 1
    || (search.classList.contains("centered") && $(ACTIONS.find(a => !$(a.id).hidden)?.id || "moreBtn").getBoundingClientRect().left < search.getBoundingClientRect().right + 8);
  if (!bar.offsetWidth) return;
  // Measured with the longer title, so both views keep the same buttons and
  // the view button its place.
  const text = title.textContent;
  title.textContent = "Archive";
  // Desktop: the title keeps the longer one's width, so the search stays in place too.
  title.style.minWidth = "";
  if (wide.matches) title.style.minWidth = title.scrollWidth + "px";
  // Desktop: the search leaves the middle and sits after the title, narrower.
  if (tight()) search.classList.remove("centered");
  for (let i = 0; i < FOLD_ORDER.length && tight(); i++) {
    const btn = $(FOLD_ORDER[i]);
    if (!btn.hidden) { btn.hidden = true; btn.dataset.folded = "1"; }
  }
  title.textContent = text;
}

function moreMenu() {
  const s = state.settings;
  const sync = state.sync;
  const hidden = ACTIONS.filter(a => $(a.id).dataset.folded).map(a => a.menu());
  // The trash is reached under ⋮ only (decided 2026-10-15 over a button in the archive: deleted notes are rarely needed); swiping and back lead out of it to the archive.
  const trashEntry = state.view !== "trash" && { label: `Trash (${trashNotes().length})`, icon: "trash", onSelect: () => setView("trash") };
  openMenu($("moreBtn"), [
    ...hidden,
    { label: "Export…", icon: "download", onSelect: exportDialog },
    trashEntry,
    { label: "Settings…", icon: "settings", onSelect: () => openSettings() },
    { section: "Prototype" },
    s.storageHintHidden && { label: "Show storage hint again", onSelect: showHintAgain },
    sync.simulated && { label: sync.offline ? "Go online" : "Go offline", onSelect: () => setOffline(!sync.offline) },
    sync.simulated && sync.enabled && { label: "Simulate contact request", onSelect: simulateRequest },
    sync.simulated && sync.enabled && { label: "Simulate device removal", onSelect: simulateRemoval },
    // What a device sees once the server no longer serves its app version (backlog #51; real case: sync/client.js → fail).
    sync.simulated && sync.enabled && { label: sync.outdated ? "End outdated app" : "Simulate outdated app", onSelect: () => setSync({ outdated: !sync.outdated }) },
  ].filter(Boolean));
}

// What a device sees once another one removed it: sync off, the notes kept as private ones, a card above them
// (ui/sync-notice.js; the real case: sync/client.js → detach).
function simulateRemoval() {
  replaceFiles({ file: detachedFile(state.file, state.shared, ""), shared: [], sync: { ended: "removed" } });
}

// The + button: a new note in the main view; in the archive it moves to the
// left and turns into a bin that empties the archive (set apart from + so the
// two aren't mixed up). In the trash the same bin deletes the selected notes
// permanently: greyed out until notes are selected, kept apart from Restore
// in the selection bar.
function renderFab() {
  const fab = $("fab");
  const label = { open: "New note (hold to dictate)", closed: "Empty archive", trash: "Delete selected permanently" }[state.view];
  fab.setAttribute("aria-label", label);
  fab.title = state.view === "open" ? "" : label;
  // Also in the main view, so the bin a swipe brings in looks as it will.
  fab.classList.toggle("inert", state.view === "trash" ? !state.selected.size : !allNotes().some(n => n.status === "closed"));
}
const fabTap = () => state.view === "open" ? newNote()
  : $("fab").classList.contains("inert") ? null
  : state.view === "trash" ? purgeSelected() : emptyArchive();

// ⋮ → "Export…": this view in the order the list shows it (filter and search
// applied; the main view can add its archive below), or all files, one
// Markdown file each, in the views' order.
function exportDialog() {
  const items = notes => notes.map(note => ({ note, text: note.body }));
  const archive = (notes, search) => ({ label: "Archive", items: items(tilesOf("closed", inView(notes, "closed", search)).tiles) });
  const files = [{ key: "", name: "Private" }, ...sharedFiles().map(f => ({ key: f.key, name: circleName(f.key) }))]
    .filter(f => f.key === "" || circleNotes(f.key).length);
  openExport({
    count: tilesOf(state.view, currentNotes()).tiles.length,
    fileCount: files.length,
    archiveInView: state.view === "closed",
    view: withArchive => [
      { items: items(tilesOf(state.view, currentNotes()).tiles) },
      ...(withArchive && state.view === "open" ? [archive(listed(), state.search)] : []),
    ],
    files: withArchive => {
      const taken = [];
      return files.map(f => {
        const name = exportFileName(f.name, taken);
        taken.push(name);
        const notes = circleNotes(f.key);
        return { name, groups: [{ items: items(tilesOf("open", inView(notes, "open", "")).tiles) }, ...(withArchive ? [archive(notes, "")] : [])] };
      });
    },
  });
}

// A note link (ui/note-links.js) or "Go to original" shows its note: in the view it belongs to, and with search
// and filters cleared when they hide it, scrolled into view.
function showNote(id) {
  const n = note(id);
  if (!n) return;
  endSelection();
  const view = n.status === "closed" ? "closed" : "open";
  if (state.view !== view) setView(view);
  const find = () => document.querySelector(`#list .note[data-id="${id}"]`);
  if (!find()) {
    setPicking(null);
    leaveEntry("search");
    setUi({ search: "", circles: [], labels: [] });
    app.classList.remove("searching");
  }
  find()?.scrollIntoView({ block: "center" });
  flashNote(id);
}

function wire() {
  for (const [id, name] of [["searchBtn", "search"], ["moreBtn", "more"], ["searchClose", "close"], ["hitPrev", "up"], ["hitNext", "down"], ["tocLess", "minus"], ["tocMore", "plus"], ["tocProgress", "checkbox"], ]) $(id).innerHTML = icon(name);
  $("dueBtn").querySelector(".btn-icon").innerHTML = icon("calendar");
  $("dueBtn").addEventListener("click", openDue);
  $("viewBtn").querySelector(".to-archive .btn-icon").innerHTML = icon("archive");
  $("viewBtn").querySelector(".to-notes .btn-icon").innerHTML = icon("notes");
  $("searchIcon").innerHTML = icon("search");
  $("fab").querySelector(".fab-new").innerHTML = icon("plus");
  $("fab").querySelector(".fab-empty").innerHTML = icon("trash");
  window.addEventListener("resize", fitTopbar);
  $("syncBtn").addEventListener("click", openSyncPanel);
  $("syncBtn").addEventListener("animationend", e => { if (e.target === $("syncBtn")) $("syncBtn").classList.remove("just-synced"); });

  // One button switches between the notes and the archive, in the same place; from the trash it leads to the notes.
  $("viewBtn").addEventListener("click", () => setView(state.view === "open" ? "closed" : "open"));
  // Back from the trash (its entry left; the layers above it have their own) goes to the archive.
  window.addEventListener("popstate", () => {
    if (state.view === "trash" && (history.state?.depth ?? 0) < trashDepth) setView("closed", { fromHistory: true });
  });
  $("sortFab").addEventListener("click", () => sortMenu());
  $("tocSort").addEventListener("click", () => sortMenu($("tocSort")));
  $("panelTabs").addEventListener("click", e => { const t = e.target.closest(".panel-tab"); if (t) setUi({ panelTab: t.dataset.tab }); });
  $("moreBtn").addEventListener("click", moreMenu);
  $("searchInput").addEventListener("input", e => {
    if (e.target.value && !history.state?.search) pushEntry({ search: true });
    setUi({ search: e.target.value, topId: null });
  });
  $("searchBtn").addEventListener("click", () => {
    app.classList.add("searching");
    if (!history.state?.search) pushEntry({ search: true });
    $("searchInput").focus();
  });
  $("searchClose").addEventListener("click", () => endSearch());
  window.addEventListener("popstate", () => {
    if ((state.search || app.classList.contains("searching")) && !history.state?.search) endSearch({ fromHistory: true });
  });
  systemDark.addEventListener("change", render);
  window.addEventListener("scroll", () => $("topbar").classList.toggle("scrolled", window.scrollY > 4), { passive: true });

  // Desktop keys: "/" search, "n" new note, Esc closes panels and menus.
  document.addEventListener("keydown", e => {
    const typing = e.target.closest("input, textarea, [contenteditable]");
    if (e.key === "Escape") {
      closeMenu(); setTocOpen(false);
      if (e.target === $("searchInput")) endSearch();
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "/") { e.preventDefault(); app.classList.add("searching"); $("searchInput").focus(); }
    else if (e.key === "n") { e.preventDefault(); newNote(); }
  });
  initToc({ pileOf: (view, notes) => tilesOf(view, notes), onArrange: arrange, onTogglePile: () => toggleSection(PILE_ID), onToggleSection: toggleSection });
  initWatchBar();
  initSearchSuggest({ data: suggestData, pick: pickSuggestion, lead: suggestionLead });
  initSearchHits();
  // Picking a single circle or label on the phone closes the sheet; the chips above the list show it.
  // Adding one to the filter keeps it open (ui/filter-pick.js).
  const picked = close => { if (close && phone.matches) setTocOpen(false); };
  initPeople({ onPick: picked, onAdd: openSyncPanel });
  initLabels({ onPick: picked });
  initMenu();
  initConfirm();
  initExternal();
  initCompare();
  document.addEventListener("notedown:show-note", e => showNote(e.detail.id));
  initArrange();
  initMoveTo();
  initToolbar({ onDue: sortInByDue });
  recorder = initRecorder({ onTap: fabTap, canHold: () => state.view === "open", holdBlocked: dictationBlocked, onTranscript: addDictatedNote });
  initSelection({ viewNotes: currentNotes, onMerged, onMoved, onChange: () => { renderToc(currentNotes()); renderFab(); } });
  initDragDrop({ onMoved });
  initSyncPanel();
  initContactRequests();
  initPullRefresh({
    canPull: target => state.sync.enabled && !state.editingId && !state.selected.size && $("syncPanel").hidden && $("menu").hidden
      && !app.classList.contains("toc-open") && !target.closest(".toc-panel, .recorder, .fab, .topbar, .selectbar"),
    onRefresh: syncOnRequest,
  });
  // Swiping sideways switches views on the list (the archive lies right of the
  // notes, the trash right of the archive; the contents list moves along) and
  // tabs on the contents panel (also the open sheet).
  const canSwipe = target => !state.editingId && !state.selected.size && $("syncPanel").hidden && $("menu").hidden
    && !app.classList.contains("recording") && !target.closest(".topbar, .selectbar, .toc-handle");
  initViewSwipe({
    order: ["open", "closed", "trash"],
    canSwipe: target => canSwipe(target) && !!target.closest(".main, .scrim"),
    canEnter: view => view !== "trash",   // only by its ⋮ entry, swiped back from
    view: () => state.view,
    setView,
    lanes: swipeLanes,
    // The + turns into the bin as the archive comes in (--archive: 0 notes, 1 archive).
    follow: (pos, ms) => {
      for (const fab of [$("fab"), $("sortFab")]) {
        if (pos === null) { fab.style.removeProperty("--archive"); fab.style.removeProperty("--archive-ms"); continue; }
        fab.style.setProperty("--archive", Math.min(pos, 1));   // the trash keeps the archive's bin
        fab.style.setProperty("--archive-ms", ms + "ms");
      }
    },
  });
  initViewSwipe({
    order: PANEL_TABS,
    canSwipe: target => canSwipe(target) && !!target.closest(".toc-panel"),
    view: () => state.panelTab,
    setView: tab => setUi({ panelTab: tab }),
    lanes: tabLanes,
  });
}

// URL parameters set prototype options, e.g. ?flavor=mocha&view=closed
function applyUrlOptions() {
  const p = new URLSearchParams(location.search);
  const patch = {};
  if (p.get("flavor") && FLAVORS[p.get("flavor")]) patch.flavor = p.get("flavor");
  // ?sort=custom starts the main view in Shelves (screenshots of the pile and shelves).
  if (p.get("sort") === "custom") patch.sort = { ...state.settings.sort, open: { key: "custom", dir: "asc" } };
  if (Object.keys(patch).length) Object.assign(state.settings, patch);
  if (["closed", "trash"].includes(p.get("view"))) state.view = p.get("view");
  // ?api=<url> points this browser at another sync server (local testing).
  if (p.get("api") !== null) writeApi(p.get("api"));
  // ?sample replaces the stored notes with the sample notes (screenshots,
  // demos); with sync=off they come without the sample identity.
  const syncOff = p.get("sync") === "off";
  return p.get("sample") !== null || syncOff ? { sync: !syncOff } : null;
}

// The sync server (`api`) and the web address invitation links start with
// (`web`): app/config.json, written by the deploy workflows; empty in the
// repository, so a local copy has no sync unless ?api= sets one.
async function loadConfig() {
  try { return await (await fetch(new URL("../config.json", import.meta.url), { cache: "no-store" })).json(); } catch { return {}; }
}
function readApi() {
  try { return localStorage.getItem("notedown.api") || ""; } catch { return ""; }
}
function writeApi(url) {
  try { url ? localStorage.setItem("notedown.api", url) : localStorage.removeItem("notedown.api"); } catch { /* not stored */ }
}

async function start() {
  wire();
  const hadFile = await load();
  // The native side applies these before the web code loads; keep it in step with the stored choice.
  if (isNativeApp()) privacyPlugin().set(state.settings.privacy).catch(() => {});
  initAppLock();
  const sample = applyUrlOptions();
  if (state.view === "trash") enterTrash();
  if (sample) replaceFiles(await loadSampleState(sample));
  else if (!hadFile) await loadWelcome();
  purgeExpiredTrash();
  followOtherTabs();
  initSyncSim();
  const config = await loadConfig();
  setAppInfo(config);
  initSync(readApi() || config.api, webAddress(config.web));
  render();
  initInviteLinks(openInvite);
  initQuickCapture({ new: quickNewNote, dictate: quickDictate });
  // After the notes are loaded: a reminder tapped while the app was closed opens the Due page.
  initReminders({ open: openDue });
  initExport();
  initStorageHint({ onSync: openSyncPanel, onExport: exportDialog });
  initSyncNotice({ onLink: openLinkPage, onSync: openSyncPanel });
  // After the notes are loaded: new files in this device's folder sources become notes.
  initFolderSources();
  document.body.dataset.ready = "1";
}

start();

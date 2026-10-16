// NoteDown prototype: wires the store to the views.
import { viewNotes, closedOn, SORT_KEYS, DIR_LABELS, permanentFirst, customSplit, rearrange, TRASH_DAYS } from "./core/query.js";
import { state, load, followOtherTabs, subscribe, updateSettings, setUi, addNote, purgeNotes, removeNotes, replaceFiles, allNotes, trashNotes, purgeExpiredTrash, circleOf, circleNotes, activeCircle, customOrder, setCustomOrder, circleOrder, setCircleOrder, sharedFiles, newsNotes } from "./store.js";
import { NEWS, freshCount } from "./core/news.js";
import { trackNews } from "./ui/news-seen.js";
import { parseNotesFile } from "./core/notes-file.js";
import { welcomeNotes, detachedFile } from "./core/sync-state.js";
import { loadSampleState } from "./sample.js";
import { initSyncSim, setOffline } from "./sync-sim.js";
import { initSync } from "./sync/client.js";
import { initSyncPanel, openSyncPanel, statusText, syncOnRequest, openInvite, openLinkPage } from "./ui/sync-panel.js";
import { initSyncNotice } from "./ui/sync-notice.js";
import "./ui/history.js";
import { initInviteLinks, webAddress } from "./invite-link.js";
import { initContactRequests, simulateRequest } from "./ui/contact-requests.js";
import "./ui/verify-contact.js";
import { initPullRefresh } from "./ui/pull-refresh.js";
import { initViewSwipe } from "./ui/view-swipe.js";
import { pushEntry, leaveEntry, afterLeave } from "./ui/dom.js";
import { renderList, reorderList, listItems, patchNote, startEdit, flashNote } from "./ui/note-list.js";
import { renderToc, tocItems, initToc, setTocOpen } from "./ui/toc.js";
import { initSearchHits } from "./ui/search-hits.js";
import { renderPeople, initPeople, circleName, pickCircle, newsBadgeHtml } from "./ui/people-list.js";
import { renderLabels, initLabels } from "./ui/labels.js";
import { hasLabel } from "./core/labels.js";
import { avatarHtml, avatarStackHtml } from "./ui/people.js";
import { initToolbar } from "./ui/toolbar.js";
import { initRecorder } from "./ui/recorder.js";
import { initSelection, syncSelection, endSelection, purgeSelected } from "./ui/selection.js";
import { openMenu, initMenu, closeMenu } from "./ui/menu.js";
import { hideSnackbar, showSnackbar } from "./ui/snackbar.js";
import { initConfirm, openConfirm } from "./ui/confirm.js";
import { initArrange, openArrange } from "./ui/arrange.js";
import { initReminders, simulateReminder } from "./ui/reminders.js";
import { initExport, openExport } from "./ui/export.js";
import { initStorageHint, showHintAgain } from "./ui/storage-hint.js";
import { initExternal } from "./ui/external.js";
import { openSettings, FLAVORS } from "./ui/settings.js";
import { setAppInfo } from "./app-info.js";
import { exportFileName } from "./core/export.js";
import { today } from "./ui/format.js";
import { icon } from "./ui/icons.js";

const $ = id => document.getElementById(id);
const app = $("app");
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

const DEFAULT_DIR = { modified: "desc", created: "desc", closed: "desc", deleted: "desc", due: "asc", title: "asc", custom: "asc" };
const TITLES = { open: "Notes", closed: "Archive", trash: "Trash" };


const phone = window.matchMedia("(max-width: 599px)");

// "Shared order" (#25) exists only in the view of a circle with people;
// elsewhere a view set to it shows the user's own custom order.
const sharedCircle = () => (activeCircle() && activeCircle() !== NEWS ? activeCircle() : null);
function sortOf(view = state.view) {
  const sort = state.settings.sort[view];
  return SORT_KEYS[sort.key].circleOnly && !sharedCircle() ? { key: "custom", dir: "asc" } : sort;
}
const orderIds = (view = state.view) => sortOf(view).key === "shared" ? circleOrder(sharedCircle()) : customOrder();
const inView = (notes, view = state.view, search = state.search) => viewNotes(notes, { status: view, search, sort: sortOf(view), order: orderIds(view) });
// The notes the list shows before view and search: the circle filter, then the label filter.
const withLabel = notes => state.label === null ? notes : notes.filter(n => hasLabel(n.body, state.label));
const listed = () => withLabel(circleNotes(activeCircle()));
const isCustom = (view = state.view) => !!SORT_KEYS[sortOf(view).key].custom;

// The members a new note goes to: those of the circle the list is filtered to.
// From the news, which take no notes, the list goes back to all notes first.
function newNoteMembers() {
  if (activeCircle() === NEWS) setUi({ circle: null }, "silent");
  return activeCircle() ? activeCircle().split("+") : [];
}

function currentNotes() {
  const notes = inView(listed());
  const i = notes.findIndex(n => n.id === state.topId);
  if (i > 0) notes.unshift(...notes.splice(i, 1));
  return notes;
}

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

function render() {
  const s = state.settings;
  const flavor = s.flavor === "system" ? (systemDark.matches ? "mocha" : "latte") : s.flavor;
  document.documentElement.dataset.flavor = flavor;
  app.dataset.view = state.view;
  app.classList.toggle("has-search", state.search !== "");

  $("title").textContent = TITLES[state.view];
  const sort = sortOf();
  $("sortLabel").textContent = SORT_KEYS[sort.key].label;
  $("sortBtn").setAttribute("aria-label", "Sort: " + SORT_KEYS[sort.key].label);
  $("sortBtn").title = "Sort: " + SORT_KEYS[sort.key].label;
  const count = closedOn(allNotes(), today());
  $("archiveCount").textContent = count;
  $("archiveCount").classList.toggle("has", count > 0);
  $("viewBtn").setAttribute("aria-label", state.view === "open" ? `Archive, ${count} closed today` : "Notes");
  $("viewBtn").title = state.view === "open" ? `Archive · ${count} closed today` : "Notes";
  $("viewHint").hidden = state.view !== "trash";
  renderFab();
  if ($("searchInput").value !== state.search) $("searchInput").value = state.search;

  renderSyncStatus();
  fitTopbar();
  renderCircleFilter();
  const notes = currentNotes();
  const { tiles, dividerBefore } = tilesOf(state.view, notes);
  renderList(tiles, { dividerBefore, onArrange: arrange });
  trackNews();
  syncSelection(notes);
  renderToc(notes);
  const empty = $("empty");
  empty.hidden = notes.length > 0;
  empty.textContent = emptyText(state.view, state.search);
}

// The tiles of a view: "Permanent first" (main view) orders only the tiles (the
// contents keep the sort order); the custom order puts a divider above the first
// note not sorted yet (permanent ones stay on top with "Permanent first").
function tilesOf(view, notes) {
  const onTop = view === "open" && state.settings.permanentFirst;
  const tiles = onTop ? permanentFirst(notes) : notes;
  const sorted = new Set(orderIds(view));
  const unsorted = isCustom(view) ? tiles.find(n => !sorted.has(n.id) && !(onTop && n.status === "permanent") && n.id !== state.topId) : null;
  return { tiles, dividerBefore: unsorted?.id ?? null };
}

function emptyText(view, search) {
  const circle = activeCircle();
  return search ? `No notes match “${search}”.`
    : state.label !== null ? `No notes labelled #${state.label} here.`
    : view === "trash" ? "The trash is empty."
    : circle === NEWS ? (view === "open" ? "No news right now." : "No archived news.")
    : circle && view === "open" ? `Nothing shared with ${circleName(circle)} yet. Tap + to start.`
    : circle === "" && view === "open" ? "No private notes. Tap + to add one."
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
    preview: listShows ? view => { const l = document.createElement("div"); l.className = "toc-list"; l.append(...tocItems(inView(listed(), view, ""), "")); return [l]; } : null,
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
  const { tiles, dividerBefore } = tilesOf(view, notes);
  const nodes = [];
  if (!$("filterBar").hidden) nodes.push($("filterBar").cloneNode(true));
  const list = document.createElement("div");
  list.className = "list";
  list.append(...listItems(tiles, { dividerBefore, view }));
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

// The people and label overviews and the chips of the active filters above the list.
function renderCircleFilter() {
  const circle = activeCircle();
  app.dataset.tab = state.panelTab;
  for (const t of document.querySelectorAll(".panel-tab")) t.setAttribute("aria-selected", String(t.dataset.tab === app.dataset.tab));
  renderPeople(key => inView(withLabel(circleNotes(key))).length);
  renderLabels(inView(circleNotes(circle)));
  // New or updated news: a badge on the People tab and on the phone's closed contents sheet.
  const fresh = freshCount(newsNotes());
  document.querySelector('.panel-tab[data-tab="people"]').innerHTML = "People" + newsBadgeHtml(fresh);
  $("tocHandle").innerHTML = newsBadgeHtml(fresh);
  $("filterBar").hidden = circle === null && state.label === null;
  $("filterChip").hidden = circle === null;
  if (circle === null) return;
  const members = circle && circle !== NEWS ? circle.split("+") : [];
  const lead = circle === NEWS ? icon("news") : !members.length ? icon("lock") : members.length === 1 ? avatarHtml(members[0], "small") : avatarStackHtml(members);
  $("filterChipLabel").innerHTML = lead + `<span></span>`;
  $("filterChipLabel").lastChild.textContent = circleName(circle);
}

subscribe(kind => {
  if (kind === "sync") { renderSyncStatus(); return fitTopbar(); }   // the sync panel follows these itself
  if (kind.startsWith("note:")) {
    patchNote(kind.slice(5));
    renderToc(currentNotes());
  } else if (!state.editingId) {
    render();
  }
});

// Sorted by due date, a new due date sorts its note in at once; the note
// stays where it is on screen and the list moves around it.
function sortInByDue(id) {
  if (sortOf().key !== "due") return;
  const top = () => document.querySelector(`#list .note[data-id="${id}"]`)?.getBoundingClientRect().top;
  const before = top();
  const { tiles, dividerBefore } = tilesOf(state.view, currentNotes());
  reorderList(tiles, { keepId: id, dividerBefore, onArrange: arrange });
  if (before !== undefined) window.scrollBy(0, top() - before);
}

// The trash lies right of the archive (ui/view-swipe.js): the back key leads
// from it to the archive, so it sits on a history entry of its own.
let trashDepth = 0;
const enterTrash = () => pushEntry({ trash: true }, depth => { trashDepth = depth; });

function setView(view, { fromHistory = false } = {}) {
  if (state.view === view) return;
  endSelection();
  hideSnackbar();
  if (state.view === "trash" && !fromHistory) afterLeave(() => leaveEntry("trash"));
  if (view === "trash") enterTrash();
  setUi({ view, search: "", topId: null });
  app.classList.remove("searching");
  window.scrollTo(0, 0);
  $("tocList").scrollTop = 0;
}

function newNote() {
  endSelection();
  if (state.view !== "open") setView("open");
  if (state.search) setUi({ search: "" }, "silent");
  const n = addNote("", newNoteMembers());
  state.topId = n.id;
  render();
  window.scrollTo(0, 0);
  startEdit(n.id);
}

// A dictated note: no heading, the transcript is its text.
function addDictatedNote(text) {
  if (state.view !== "open") setView("open");
  if (state.search) setUi({ search: "" }, "silent");
  const n = addNote(text, newNoteMembers());
  state.topId = n.id;
  render();
  window.scrollTo(0, 0);
  flashNote(n.id);
  showSnackbar("Dictated note added", () => purgeNotes([n.id]));
}

// A merged note (or one made from moved sections) appears at the top of the list.
function onMerged(n, undo, message) {
  setTocOpen(false);
  state.topId = n.id;
  render();
  window.scrollTo(0, 0);
  flashNote(n.id);
  showSnackbar(message, undo);
}

// The arrange dialog over the notes the list shows: the user's own custom
// order, or the shared order of the circle in view.
function arrange() {
  const shown = inView(listed());
  const key = sortOf().key === "shared" ? sharedCircle() : null;
  const { sorted, unsorted } = customSplit(shown, orderIds());
  const next = ids => rearrange(orderIds(), shown.map(n => n.id), ids);
  openArrange(key ? {
    view: state.view,
    title: "Shared order", hint: `You and ${circleName(key)} see and can change this order.`, sorted, unsorted,
    save: ids => showSnackbar("Shared order saved", setCircleOrder(key, next(ids))),
  } : {
    view: state.view,
    sorted, unsorted,
    save: ids => showSnackbar("Order saved", setCustomOrder(next(ids))),
  });
}

function sortMenu(anchor = $("sortBtn")) {
  const sort = sortOf();
  const keys = Object.entries(SORT_KEYS).filter(([, v]) => (!v.views || v.views.includes(state.view)) && (!v.circleOnly || sharedCircle()));
  const dirs = DIR_LABELS[sort.key] || DIR_LABELS.default;
  // A sort change ends a new note's place on top, like a view or search change.
  const reorder = patch => { state.topId = null; updateSettings(patch); };
  const setSort = next => reorder({ sort: { ...state.settings.sort, [state.view]: next } });
  const onTop = state.settings.permanentFirst;
  openMenu(anchor, [
    { section: "Sort by" },
    ...keys.map(([key, v]) => ({ label: v.label, checked: sort.key === key, onSelect: () => setSort({ key, dir: DEFAULT_DIR[key] }) })),
    { separator: true },
    // A custom order has no direction; it is arranged instead.
    ...(SORT_KEYS[sort.key].custom ? [{ label: "Arrange…", onSelect: arrange }] : [
      { label: dirs[1], checked: sort.dir === "desc", onSelect: () => setSort({ ...sort, dir: "desc" }) },
      { label: dirs[0], checked: sort.dir === "asc", onSelect: () => setSort({ ...sort, dir: "asc" }) },
    ]),
    ...(state.view === "open" ? [
      { separator: true },
      { label: "Permanent first", checked: onTop, onSelect: () => reorder({ permanentFirst: !onTop }) },
    ] : []),
  ]);
}

// The archive's bin button (renderFab): moves every closed note into the trash; shared notes only when
// ticked, as they go for everyone in their circle.
function emptyArchive() {
  const closed = allNotes().filter(n => n.status === "closed");
  const shared = closed.filter(n => circleOf(n.id).length);
  const own = closed.length - shared.length;
  const notes = n => n === 1 ? "1 note" : `${n} notes`;
  const ids = withShared => closed.filter(n => withShared || !circleOf(n.id).length).map(n => n.id);
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

// The top bar's actions, left to right; what doesn't fit moves under ⋮,
// from the right end (Export first). The sort label goes before any button.
const ACTIONS = [
  { id: "sortBtn", menu: () => ({ label: "Sort: " + SORT_KEYS[sortOf().key].label, icon: "sort", onSelect: () => sortMenu($("moreBtn")) }) },
  { id: "viewBtn", menu: () => state.view === "open"
    ? { label: `Archive (${closedOn(allNotes(), today())} today)`, icon: "archive", onSelect: () => setView("closed") }
    : { label: "Notes", icon: "notes", onSelect: () => setView("open") } },
  { id: "syncBtn", menu: () => ({ label: "Sync & sharing…", icon: state.sync.enabled ? SYNC_ICONS[state.sync.status] : "cloud", onSelect: openSyncPanel }) },
  { id: "exportBtn", menu: () => ({ label: "Export…", icon: "download", onSelect: exportDialog }) },
];
const wide = window.matchMedia("(min-width: 1024px)");

function fitTopbar() {
  const bar = $("topbar");
  const title = $("title");
  const search = $("search");
  const label = $("sortBtn").querySelector(".btn-label");
  for (const a of ACTIONS) { $(a.id).hidden = false; delete $(a.id).dataset.folded; }
  label.hidden = false;
  // Too tight: the title is cut, or (desktop) the buttons run into the centered search.
  const tight = () => title.scrollWidth > title.clientWidth + 1
    || (wide.matches && $(ACTIONS.find(a => !$(a.id).hidden)?.id || "moreBtn").getBoundingClientRect().left < search.getBoundingClientRect().right + 8);
  if (!bar.offsetWidth) return;
  // Measured with the longer title, so both views keep the same buttons and
  // the view button its place.
  const text = title.textContent;
  title.textContent = "Archive";
  if (tight()) label.hidden = true;
  for (let i = ACTIONS.length - 1; i >= 0 && tight(); i--) {
    const btn = $(ACTIONS[i].id);
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
    trashEntry,
    { label: "Settings…", icon: "settings", onSelect: () => openSettings() },
    { section: "Prototype" },
    s.storageHintHidden && { label: "Show storage hint again", onSelect: showHintAgain },
    sync.simulated && { label: sync.offline ? "Go online" : "Go offline", onSelect: () => setOffline(!sync.offline) },
    sync.simulated && sync.enabled && { label: "Simulate contact request", onSelect: simulateRequest },
    sync.simulated && sync.enabled && { label: "Simulate device removal", onSelect: simulateRemoval },
    { label: "Simulate reminder", onSelect: simulateReminder },
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

// A tapped reminder shows its notes: the open notes, unfiltered, the first one scrolled into view.
function showDue(ids) {
  endSelection();
  if (state.view !== "open") setView("open");
  setUi({ search: "", circle: null, label: null });
  app.classList.remove("searching");
  const first = document.querySelector(`.note[data-id="${ids[0]}"]`);
  first?.scrollIntoView({ block: "center" });
  ids.forEach(flashNote);
}

function wire() {
  for (const [id, name] of [["searchBtn", "search"], ["moreBtn", "more"], ["exportBtn", "download"], ["searchClose", "close"], ["hitPrev", "up"], ["hitNext", "down"], ["tocLess", "minus"], ["tocMore", "plus"], ["filterClear", "close"], ["labelClear", "close"]]) $(id).innerHTML = icon(name);
  $("sortBtn").querySelector(".btn-icon").innerHTML = icon("sort");
  $("viewBtn").querySelector(".to-archive .btn-icon").innerHTML = icon("archive");
  $("viewBtn").querySelector(".to-notes .btn-icon").innerHTML = icon("notes");
  $("searchIcon").innerHTML = icon("search");
  $("fab").querySelector(".fab-new").innerHTML = icon("plus");
  $("fab").querySelector(".fab-empty").innerHTML = icon("trash");
  $("exportBtn").addEventListener("click", exportDialog);
  window.addEventListener("resize", fitTopbar);
  $("syncBtn").addEventListener("click", openSyncPanel);
  $("syncBtn").addEventListener("animationend", e => { if (e.target === $("syncBtn")) $("syncBtn").classList.remove("just-synced"); });

  // One button switches between the notes and the archive, in the same place; from the trash it leads to the notes.
  $("viewBtn").addEventListener("click", () => setView(state.view === "open" ? "closed" : "open"));
  // Back from the trash (its entry left; the layers above it have their own) goes to the archive.
  window.addEventListener("popstate", () => {
    if (state.view === "trash" && (history.state?.depth ?? 0) < trashDepth) setView("closed", { fromHistory: true });
  });
  $("sortBtn").addEventListener("click", () => sortMenu());
  $("panelTabs").addEventListener("click", e => { const t = e.target.closest(".panel-tab"); if (t) setUi({ panelTab: t.dataset.tab }); });
  $("filterClear").addEventListener("click", () => pickCircle(null));
  $("moreBtn").addEventListener("click", moreMenu);
  $("searchInput").addEventListener("input", e => setUi({ search: e.target.value, topId: null }));
  $("searchBtn").addEventListener("click", () => { app.classList.add("searching"); $("searchInput").focus(); });
  $("searchClose").addEventListener("click", () => { app.classList.remove("searching"); setUi({ search: "" }); });
  systemDark.addEventListener("change", render);
  window.addEventListener("scroll", () => $("topbar").classList.toggle("scrolled", window.scrollY > 4), { passive: true });

  // Desktop keys: "/" search, "n" new note, Esc closes panels and menus.
  document.addEventListener("keydown", e => {
    const typing = e.target.closest("input, textarea, [contenteditable]");
    if (e.key === "Escape") {
      closeMenu(); setTocOpen(false);
      if (e.target === $("searchInput")) { app.classList.remove("searching"); setUi({ search: "" }); e.target.blur(); }
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "/") { e.preventDefault(); app.classList.add("searching"); $("searchInput").focus(); }
    else if (e.key === "n") { e.preventDefault(); newNote(); }
  });
  initToc();
  initSearchHits();
  // Picking a circle on the phone closes the sheet; the chip above the list shows it.
  initPeople({ onPick: () => { if (phone.matches) setTocOpen(false); }, onAdd: openSyncPanel });
  initLabels({ onPick: () => { if (phone.matches) setTocOpen(false); } });
  initMenu();
  initConfirm();
  initExternal();
  initArrange();
  initToolbar({ onDue: sortInByDue });
  initRecorder({ onTap: fabTap, canHold: () => state.view === "open", onTranscript: addDictatedNote });
  initSelection({ viewNotes: currentNotes, onMerged, onChange: () => { renderToc(currentNotes()); renderFab(); } });
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
      const fab = $("fab");
      if (pos === null) { fab.style.removeProperty("--archive"); fab.style.removeProperty("--archive-ms"); return; }
      fab.style.setProperty("--archive", Math.min(pos, 1));   // the trash keeps the archive's bin
      fab.style.setProperty("--archive-ms", ms + "ms");
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
  const hadFile = load();
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
  // After the notes are loaded: a reminder tapped while the app was closed opens its notes.
  initReminders({ open: showDue });
  initExport();
  initStorageHint({ onSync: openSyncPanel, onExport: exportDialog });
  initSyncNotice({ onLink: openLinkPage, onSync: openSyncPanel });
  document.body.dataset.ready = "1";
}

start();

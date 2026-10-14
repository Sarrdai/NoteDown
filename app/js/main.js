// NoteDown prototype: wires the store to the views.
import { viewNotes, closedOn, SORT_KEYS, protectedFirst, deleteGroups, customSplit, rearrange } from "./core/query.js";
import { state, load, subscribe, updateSettings, setUi, addNote, removeNote, removeNotes, replaceFiles, fileText, allNotes, isProtected, circleOf, circleNotes, activeCircle, hasPeople, customOrder, setCustomOrder, circleOrder, setCircleOrder } from "./store.js";
import { parseNotesFile, createNote, timestamp, newId } from "./core/notes-file.js";
import { WELCOME_PREFIX } from "./core/sync-state.js";
import { loadSampleState } from "./sample.js";
import { initSyncSim, setOffline } from "./sync-sim.js";
import { initSync } from "./sync/client.js";
import { initSyncPanel, openSyncPanel, statusText, syncOnRequest } from "./ui/sync-panel.js";
import { initContactRequests, simulateRequest } from "./ui/contact-requests.js";
import { initPullRefresh } from "./ui/pull-refresh.js";
import { initViewSwipe } from "./ui/view-swipe.js";
import { renderList, listItems, patchNote, startEdit, flashNote } from "./ui/note-list.js";
import { renderToc, initToc, setTocOpen } from "./ui/toc.js";
import { renderPeople, initPeople, circleName, pickCircle } from "./ui/people-list.js";
import { avatarHtml, avatarStackHtml } from "./ui/people.js";
import { initToolbar } from "./ui/toolbar.js";
import { initRecorder } from "./ui/recorder.js";
import { initSelection, syncSelection, endSelection } from "./ui/selection.js";
import { openMenu, initMenu, closeMenu } from "./ui/menu.js";
import { hideSnackbar, showSnackbar } from "./ui/snackbar.js";
import { initConfirm, openConfirm } from "./ui/confirm.js";
import { initArrange, openArrange } from "./ui/arrange.js";
import { initReminders, openReminderDialog, simulateReminder } from "./ui/reminders.js";
import { today } from "./ui/format.js";
import { icon } from "./ui/icons.js";

const $ = id => document.getElementById(id);
const app = $("app");
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

// Prototype variants of an open decision (orchestrate → variants.md).
const REQUEST_VARIANTS = { card: "Card above the notes (A)", dialog: "Dialog (B)", badge: "Dot on the sync icon (C)" };
const FLAVORS = { system: "System", latte: "Latte", frappe: "Frappé", macchiato: "Macchiato", mocha: "Mocha" };
const DEFAULT_DIR = { modified: "desc", created: "desc", closed: "desc", due: "asc", title: "asc", custom: "asc" };
const DIR_LABELS = {
  title: ["A–Z", "Z–A"],
  due: ["Soonest first", "Latest first"],
  default: ["Oldest first", "Newest first"],
};

const phone = window.matchMedia("(max-width: 599px)");

// "Shared order" (#25) exists only in the view of a circle with people;
// elsewhere a view set to it shows the user's own custom order.
const sharedCircle = () => activeCircle() || null;
function sortOf(view = state.view) {
  const sort = state.settings.sort[view];
  return SORT_KEYS[sort.key].circleOnly && !sharedCircle() ? { key: "custom", dir: "asc" } : sort;
}
const orderIds = (view = state.view) => sortOf(view).key === "shared" ? circleOrder(sharedCircle()) : customOrder();
const inView = (notes, view = state.view, search = state.search) => viewNotes(notes, { status: view, search, sort: sortOf(view), order: orderIds(view) });
const isCustom = (view = state.view) => !!SORT_KEYS[sortOf(view).key].custom;

// The members a new note goes to: those of the circle the list is filtered to.
const newNoteMembers = () => activeCircle() ? activeCircle().split("+") : [];

function currentNotes() {
  const notes = inView(circleNotes(activeCircle()));
  const i = notes.findIndex(n => n.id === state.topId);
  if (i > 0) notes.unshift(...notes.splice(i, 1));
  return notes;
}

// The sync status: a cloud icon in the top bar while sync is on.
const SYNC_ICONS = { synced: "cloudCheck", syncing: "cloudSync", offline: "cloudOff", error: "cloudOff" };

function renderSyncStatus() {
  const btn = $("syncBtn");
  btn.hidden = !state.sync.enabled;
  if (!state.sync.enabled) return;
  const { status } = state.sync;
  if (btn.dataset.status !== status) {
    // A round that transferred something ends with the check drawing itself in.
    btn.classList.toggle("just-synced", btn.dataset.status === "syncing" && status === "synced");
    btn.dataset.status = status;
    btn.innerHTML = icon(SYNC_ICONS[status]);
  }
  btn.setAttribute("aria-label", statusText());
}

function render() {
  const s = state.settings;
  const flavor = s.flavor === "system" ? (systemDark.matches ? "mocha" : "latte") : s.flavor;
  document.documentElement.dataset.flavor = flavor;
  app.dataset.view = state.view;
  app.classList.toggle("has-search", state.search !== "");

  $("title").textContent = state.view === "open" ? "Notes" : "Archive";
  const sort = sortOf();
  $("sortLabel").textContent = SORT_KEYS[sort.key].label;
  $("sortBtn").setAttribute("aria-label", "Sort: " + SORT_KEYS[sort.key].label);
  const count = closedOn(allNotes(), today());
  $("archiveCount").textContent = count;
  $("archiveCount").classList.toggle("has", count > 0);
  $("viewBtn").setAttribute("aria-label", state.view === "open" ? `Archive, ${count} closed today` : "Notes");
  if ($("searchInput").value !== state.search) $("searchInput").value = state.search;

  renderSyncStatus();
  renderCircleFilter();
  const notes = currentNotes();
  const { tiles, dividerBefore } = tilesOf(state.view, notes);
  renderList(tiles, { dividerBefore, onArrange: arrange });
  syncSelection(notes);
  renderToc(notes);
  const empty = $("empty");
  empty.hidden = notes.length > 0;
  empty.textContent = emptyText(state.view, state.search);
}

// The tiles of a view: "Protected first" orders only the tiles (the contents
// keep the sort order); the custom order puts a divider above the first note
// not sorted yet (protected ones stay on top with "Protected first").
function tilesOf(view, notes) {
  const onTop = state.settings.protectedFirst[view];
  const tiles = onTop ? protectedFirst(notes, isProtected) : notes;
  const sorted = new Set(orderIds(view));
  const unsorted = isCustom(view) ? tiles.find(n => !sorted.has(n.id) && !(onTop && isProtected(n.id)) && n.id !== state.topId) : null;
  return { tiles, dividerBefore: unsorted?.id ?? null };
}

function emptyText(view, search) {
  const circle = activeCircle();
  return search ? `No notes match “${search}”.`
    : circle && view === "open" ? `Nothing shared with ${circleName(circle)} yet. Tap + to start.`
    : circle === "" && view === "open" ? "No private notes. Tap + to add one."
    : view === "open" ? "No open notes. Tap + to add one." : "Nothing archived yet.";
}

// What the other view will show once the swipe lands there (ui/view-swipe.js):
// the circle filter chip and the list as setView will render them, not live.
function previewView(view) {
  const notes = inView(circleNotes(activeCircle()), view, "");
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

// The people overview and the chip of the active filter above the list.
function renderCircleFilter() {
  const people = hasPeople();
  app.classList.toggle("has-people", people);
  app.dataset.tab = people ? state.panelTab : "toc";
  for (const t of document.querySelectorAll(".panel-tab")) t.setAttribute("aria-selected", String(t.dataset.tab === app.dataset.tab));
  if (people) renderPeople(key => inView(circleNotes(key)).length);
  const circle = activeCircle();
  $("filterBar").hidden = circle === null;
  if (circle === null) return;
  const members = circle ? circle.split("+") : [];
  const lead = !members.length ? icon("lock") : members.length === 1 ? avatarHtml(members[0], "small") : avatarStackHtml(members);
  $("filterChipLabel").innerHTML = lead + `<span></span>`;
  $("filterChipLabel").lastChild.textContent = circleName(circle);
}

subscribe(kind => {
  if (kind === "sync") return renderSyncStatus();   // the sync panel follows these itself
  if (kind.startsWith("note:")) {
    patchNote(kind.slice(5));
    renderToc(currentNotes());
  } else if (!state.editingId) {
    render();
  }
});

function setView(view) {
  if (state.view === view) return;
  endSelection();
  hideSnackbar();
  setUi({ view, search: "", topId: null });
  app.classList.remove("searching");
  window.scrollTo(0, 0);
}

function newNote() {
  endSelection();
  if (state.view !== "open") setView("open");
  if (state.search) setUi({ search: "" }, "silent");
  const n = addNote("## ", newNoteMembers());
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
  showSnackbar("Dictated note added", () => removeNote(n.id));
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
  const shown = inView(circleNotes(activeCircle()));
  const key = sortOf().key === "shared" ? sharedCircle() : null;
  const { sorted, unsorted } = customSplit(shown, orderIds());
  const next = ids => rearrange(orderIds(), shown.map(n => n.id), ids);
  openArrange(key ? {
    title: "Shared order", hint: `You and ${circleName(key)} see and can change this order.`, sorted, unsorted,
    save: ids => showSnackbar("Shared order saved", setCircleOrder(key, next(ids))),
  } : {
    sorted, unsorted,
    save: ids => showSnackbar("Order saved", setCustomOrder(next(ids))),
  });
}

function sortMenu() {
  const sort = sortOf();
  const keys = Object.entries(SORT_KEYS).filter(([, v]) => (!v.archiveOnly || state.view === "closed") && (!v.circleOnly || sharedCircle()));
  const dirs = DIR_LABELS[sort.key] || DIR_LABELS.default;
  const setSort = next => updateSettings({ sort: { ...state.settings.sort, [state.view]: next } });
  const onTop = state.settings.protectedFirst[state.view];
  openMenu($("sortBtn"), [
    { section: "Sort by" },
    ...keys.map(([key, v]) => ({ label: v.label, checked: sort.key === key, onSelect: () => setSort({ key, dir: DEFAULT_DIR[key] }) })),
    { separator: true },
    // A custom order has no direction; it is arranged instead.
    ...(SORT_KEYS[sort.key].custom ? [{ label: "Arrange…", onSelect: arrange }] : [
      { label: dirs[1], checked: sort.dir === "desc", onSelect: () => setSort({ ...sort, dir: "desc" }) },
      { label: dirs[0], checked: sort.dir === "asc", onSelect: () => setSort({ ...sort, dir: "asc" }) },
    ]),
    { separator: true },
    { label: "Protected first", checked: onTop, onSelect: () => updateSettings({ protectedFirst: { ...state.settings.protectedFirst, [state.view]: !onTop } }) },
  ]);
}

// ⋮ → "Empty archive…": deletes every closed note except the protected ones;
// shared notes only when ticked, as they go for everyone in their circle.
function emptyArchive() {
  const closed = allNotes().filter(n => n.status === "closed");
  const g = deleteGroups(closed, { isProtected, isShared: id => circleOf(id).length > 0 });
  const notes = n => n === 1 ? "1 note" : `${n} notes`;
  const kept = !g.kept.length ? "" : g.kept.length === 1 ? " 1 protected note stays." : ` ${g.kept.length} protected notes stay.`;
  const ids = withShared => [...g.private, ...(withShared ? g.shared : [])].map(n => n.id);
  openConfirm({
    title: "Empty archive?",
    text: (g.private.length ? `Deletes ${notes(g.private.length)} from all your devices.` : "No private notes to delete.") + kept,
    check: g.shared.length ? {
      label: `Also delete ${notes(g.shared.length)} shared with others`,
      warning: g.shared.length === 1 ? "It is deleted for everyone it is shared with." : "They are deleted for everyone they are shared with.",
    } : null,
    okLabel: withShared => ids(withShared).length ? `Delete ${ids(withShared).length}` : null,
    onConfirm: withShared => {
      const del = ids(withShared);
      showSnackbar(del.length === 1 ? "Note deleted" : `${del.length} notes deleted`, removeNotes(del));
    },
  });
}

// The first start holds only the welcome note (app/welcome.md), sync off.
async function loadWelcome() {
  const body = await (await fetch(new URL("../welcome.md", import.meta.url))).text();
  const file = parseNotesFile("");
  file.notes.push(createNote(body.trim(), timestamp(), WELCOME_PREFIX + newId()));
  replaceFiles({ file });
}

function moreMenu() {
  const s = state.settings;
  const sync = state.sync;
  const archive = state.view === "closed";
  const deletable = archive && allNotes().some(n => n.status === "closed" && !isProtected(n.id));
  openMenu($("moreBtn"), [
    archive && { label: "Empty archive…", disabled: !deletable, onSelect: emptyArchive },
    archive && { separator: true },
    { label: "Sync & sharing…", onSelect: openSyncPanel },
    { label: "Reminders…", onSelect: openReminderDialog },
    { separator: true },
    { section: "Theme" },
    ...Object.entries(FLAVORS).map(([id, label]) => ({ label, checked: s.flavor === id, onSelect: () => updateSettings({ flavor: id }) })),
    { section: "Prototype" },
    { label: "Download notes.md", onSelect: download },
    sync.simulated && { label: sync.offline ? "Go online" : "Go offline", onSelect: () => setOffline(!sync.offline) },
    sync.simulated && sync.enabled && { label: "Simulate contact request", onSelect: simulateRequest },
    { label: "Simulate reminder", onSelect: simulateReminder },
    { section: "Prototype: contact request" },
    ...Object.entries(REQUEST_VARIANTS).map(([id, label]) => ({ label, checked: s.contactRequest === id, onSelect: () => updateSettings({ contactRequest: id }) })),
  ].filter(Boolean));
}

// A tapped reminder shows its notes: the open notes, unfiltered, the first one scrolled into view.
function showDue(ids) {
  endSelection();
  if (state.view !== "open") setView("open");
  setUi({ search: "", circle: null });
  app.classList.remove("searching");
  const first = document.querySelector(`.note[data-id="${ids[0]}"]`);
  first?.scrollIntoView({ block: "center" });
  ids.forEach(flashNote);
}

function download() {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([fileText()], { type: "text/markdown" }));
  a.download = "notes.md";
  a.click();
  URL.revokeObjectURL(a.href);
}

function wire() {
  for (const [id, name] of [["searchBtn", "search"], ["moreBtn", "more"], ["fab", "plus"], ["searchClose", "close"], ["tocLess", "minus"], ["tocMore", "plus"], ["filterClear", "close"]]) $(id).innerHTML = icon(name);
  $("sortBtn").querySelector(".btn-icon").innerHTML = icon("sort");
  $("viewBtn").querySelector(".to-archive .btn-icon").innerHTML = icon("archive");
  $("viewBtn").querySelector(".to-notes .btn-icon").innerHTML = icon("notes");
  $("searchIcon").innerHTML = icon("search");
  $("syncBtn").addEventListener("click", openSyncPanel);
  $("syncBtn").addEventListener("animationend", e => { if (e.target === $("syncBtn")) $("syncBtn").classList.remove("just-synced"); });

  // One button switches between the notes and the archive, in the same place.
  $("viewBtn").addEventListener("click", () => setView(state.view === "open" ? "closed" : "open"));
  $("sortBtn").addEventListener("click", sortMenu);
  $("panelTabs").addEventListener("click", e => { const t = e.target.closest(".panel-tab"); if (t) setUi({ panelTab: t.dataset.tab }); });
  $("filterClear").addEventListener("click", () => pickCircle(null));
  $("moreBtn").addEventListener("click", moreMenu);
  $("searchInput").addEventListener("input", e => setUi({ search: e.target.value }));
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
  // Picking a circle on the phone closes the sheet; the chip above the list shows it.
  initPeople({ onPick: () => { if (phone.matches) setTocOpen(false); } });
  initMenu();
  initConfirm();
  initArrange();
  initToolbar();
  initRecorder({ onTap: newNote, onTranscript: addDictatedNote });
  initSelection({ viewNotes: currentNotes, onMerged, onChange: () => renderToc(currentNotes()) });
  initSyncPanel();
  initContactRequests();
  initPullRefresh({
    canPull: target => state.sync.enabled && !state.editingId && !state.selected.size && $("syncPanel").hidden && $("menu").hidden
      && !app.classList.contains("toc-open") && !target.closest(".toc-panel, .recorder, .fab, .topbar, .selectbar"),
    onRefresh: syncOnRequest,
  });
  // Swiping sideways switches views: the archive lies right of the notes. It
  // starts anywhere on the list and on the contents (also the open sheet),
  // which stays in place and is refilled once the view has switched.
  initViewSwipe({
    canSwipe: target => !state.editingId && !state.selected.size && $("syncPanel").hidden && $("menu").hidden
      && !app.classList.contains("recording")
      && !!target.closest(".main, .toc-panel, .scrim") && !target.closest(".topbar, .selectbar, .toc-handle, .toc-head"),
    view: () => state.view,
    setView,
    preview: previewView,
  });
}

// URL parameters set prototype options, e.g. ?flavor=mocha&view=closed
function applyUrlOptions() {
  const p = new URLSearchParams(location.search);
  const patch = {};
  if (p.get("flavor") && FLAVORS[p.get("flavor")]) patch.flavor = p.get("flavor");
  if (REQUEST_VARIANTS[p.get("request")]) patch.contactRequest = p.get("request");
  if (Object.keys(patch).length) Object.assign(state.settings, patch);
  if (p.get("view") === "closed") state.view = "closed";
  // ?api=<url> points this browser at another sync server (local testing).
  if (p.get("api") !== null) writeApi(p.get("api"));
  // ?sample replaces the stored notes with the sample notes (screenshots,
  // demos); with sync=off they come without the sample identity.
  const syncOff = p.get("sync") === "off";
  return p.get("sample") !== null || syncOff ? { sync: !syncOff } : null;
}

// The sync server: app/config.json, written by the deploy workflows; empty
// in the repository, so a local copy has no sync unless ?api= sets one.
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
  if (sample) replaceFiles(await loadSampleState(sample));
  else if (!hadFile) await loadWelcome();
  initSyncSim();
  initSync(readApi() || (await loadConfig()).api);
  render();
  // After the notes are loaded: a reminder tapped while the app was closed opens its notes.
  initReminders({ open: showDue });
  document.body.dataset.ready = "1";
}

start();

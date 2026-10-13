// NoteDown prototype: wires the store to the views.
import { viewNotes, closedOn, SORT_KEYS } from "./core/query.js";
import { state, load, subscribe, updateSettings, setUi, addNote, removeNote, replaceFiles, fileText, allNotes } from "./store.js";
import { loadSampleState } from "./sample.js";
import { initSyncSim, setOffline } from "./sync-sim.js";
import { initSyncPanel, openSyncPanel, statusText } from "./ui/sync-panel.js";
import { renderList, patchNote, startEdit, flashNote } from "./ui/note-list.js";
import { renderToc, initToc, setTocOpen } from "./ui/toc.js";
import { initToolbar } from "./ui/toolbar.js";
import { initRecorder } from "./ui/recorder.js";
import { initSelection, syncSelection, endSelection } from "./ui/selection.js";
import { openMenu, initMenu, closeMenu } from "./ui/menu.js";
import { hideSnackbar, showSnackbar } from "./ui/snackbar.js";
import { today } from "./ui/format.js";
import { icon } from "./ui/icons.js";

const $ = id => document.getElementById(id);
const app = $("app");
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

const FLAVORS = { system: "System", latte: "Latte", frappe: "Frappé", macchiato: "Macchiato", mocha: "Mocha" };
const DEFAULT_DIR = { modified: "desc", created: "desc", closed: "desc", due: "asc", title: "asc" };
const DIR_LABELS = {
  title: ["A–Z", "Z–A"],
  due: ["Soonest first", "Latest first"],
  default: ["Oldest first", "Newest first"],
};

function currentNotes() {
  const notes = viewNotes(allNotes(), { status: state.view, search: state.search, sort: state.settings.sort[state.view] });
  const i = notes.findIndex(n => n.id === state.pinnedId);
  if (i > 0) notes.unshift(...notes.splice(i, 1));
  return notes;
}

// The sync status: a cloud icon in the top bar while sync is on.
const SYNC_ICONS = { synced: "cloudCheck", syncing: "cloudSync", offline: "cloudOff" };

function renderSyncStatus() {
  const btn = $("syncBtn");
  btn.hidden = !state.sync.enabled;
  if (!state.sync.enabled) return;
  btn.dataset.status = state.sync.status;
  btn.innerHTML = icon(SYNC_ICONS[state.sync.status]);
  btn.setAttribute("aria-label", statusText());
}

function render() {
  const s = state.settings;
  const flavor = s.flavor === "system" ? (systemDark.matches ? "mocha" : "latte") : s.flavor;
  document.documentElement.dataset.flavor = flavor;
  app.dataset.view = state.view;
  app.classList.toggle("has-search", state.search !== "");

  $("title").textContent = state.view === "open" ? "Notes" : "Archive";
  const sort = s.sort[state.view];
  $("sortLabel").textContent = SORT_KEYS[sort.key].label;
  $("sortBtn").setAttribute("aria-label", "Sort: " + SORT_KEYS[sort.key].label);
  const count = closedOn(allNotes(), today());
  $("archiveCount").textContent = count;
  $("archiveCount").classList.toggle("has", count > 0);
  $("archiveBtn").setAttribute("aria-label", `Archive, ${count} closed today`);
  if ($("searchInput").value !== state.search) $("searchInput").value = state.search;

  renderSyncStatus();
  const notes = currentNotes();
  renderList(notes);
  syncSelection(notes);
  renderToc(notes);
  const empty = $("empty");
  empty.hidden = notes.length > 0;
  empty.textContent = state.search ? `No notes match “${state.search}”.`
    : state.view === "open" ? "No open notes. Tap + to add one." : "Nothing archived yet.";
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
  setUi({ view, search: "", pinnedId: null });
  app.classList.remove("searching");
  window.scrollTo(0, 0);
}

function newNote() {
  endSelection();
  if (state.view !== "open") setView("open");
  if (state.search) setUi({ search: "" }, "silent");
  const n = addNote("## ");
  state.pinnedId = n.id;
  render();
  window.scrollTo(0, 0);
  startEdit(n.id);
}

// A dictated note: no heading, the transcript is its text.
function addDictatedNote(text) {
  if (state.view !== "open") setView("open");
  if (state.search) setUi({ search: "" }, "silent");
  const n = addNote(text);
  state.pinnedId = n.id;
  render();
  window.scrollTo(0, 0);
  flashNote(n.id);
  showSnackbar("Dictated note added", () => removeNote(n.id));
}

// A merged note replaces its originals at the top of the list.
function onMerged(n, undo) {
  state.pinnedId = n.id;
  render();
  window.scrollTo(0, 0);
  flashNote(n.id);
  showSnackbar("Notes merged", undo);
}

function sortMenu() {
  const sort = state.settings.sort[state.view];
  const keys = Object.entries(SORT_KEYS).filter(([, v]) => !v.archiveOnly || state.view === "closed");
  const dirs = DIR_LABELS[sort.key] || DIR_LABELS.default;
  const setSort = next => updateSettings({ sort: { ...state.settings.sort, [state.view]: next } });
  openMenu($("sortBtn"), [
    { section: "Sort by" },
    ...keys.map(([key, v]) => ({ label: v.label, checked: sort.key === key, onSelect: () => setSort({ key, dir: DEFAULT_DIR[key] }) })),
    { separator: true },
    { label: dirs[1], checked: sort.dir === "desc", onSelect: () => setSort({ ...sort, dir: "desc" }) },
    { label: dirs[0], checked: sort.dir === "asc", onSelect: () => setSort({ ...sort, dir: "asc" }) },
  ]);
}

// With ?sync=off the sample starts without sync and shared files.
let syncOff = false;

async function resetSample() {
  replaceFiles(await loadSampleState({ sync: !syncOff }));
}

function moreMenu() {
  const s = state.settings;
  const sync = state.sync;
  openMenu($("moreBtn"), [
    { label: "Sync & sharing…", onSelect: openSyncPanel },
    { separator: true },
    { section: "Theme" },
    ...Object.entries(FLAVORS).map(([id, label]) => ({ label, checked: s.flavor === id, onSelect: () => updateSettings({ flavor: id }) })),
    { section: "Prototype" },
    { label: "Download notes.md", onSelect: download },
    { label: sync.offline ? "Go online" : "Go offline", onSelect: () => setOffline(!sync.offline) },
    { label: "Reset sample notes", onSelect: resetSample },
  ]);
}

function download() {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([fileText()], { type: "text/markdown" }));
  a.download = "notes.md";
  a.click();
  URL.revokeObjectURL(a.href);
}

function wire() {
  for (const [id, name] of [["backBtn", "back"], ["tocBtn", "toc"], ["searchBtn", "search"], ["moreBtn", "more"], ["fab", "plus"], ["searchClose", "close"], ["tocLess", "minus"], ["tocMore", "plus"]]) $(id).innerHTML = icon(name);
  $("sortBtn").querySelector(".btn-icon").innerHTML = icon("sort");
  $("archiveBtn").querySelector(".btn-icon").innerHTML = icon("archive");
  $("searchIcon").innerHTML = icon("search");
  $("syncBtn").addEventListener("click", openSyncPanel);

  $("archiveBtn").addEventListener("click", () => setView("closed"));
  $("backBtn").addEventListener("click", () => setView("open"));
  $("sortBtn").addEventListener("click", sortMenu);
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
  initMenu();
  initToolbar();
  initRecorder({ onTap: newNote, onTranscript: addDictatedNote });
  initSelection({ viewNotes: currentNotes, onMerged });
  initSyncPanel();
}

// URL parameters set prototype options, e.g. ?flavor=mocha&view=closed
function applyUrlOptions() {
  const p = new URLSearchParams(location.search);
  const patch = {};
  if (p.get("flavor") && FLAVORS[p.get("flavor")]) patch.flavor = p.get("flavor");
  if (Object.keys(patch).length) Object.assign(state.settings, patch);
  if (p.get("view") === "closed") state.view = "closed";
  syncOff = p.get("sync") === "off";
  return p.get("reset") !== null || syncOff;
}

async function start() {
  wire();
  const hadFile = load();
  const reset = applyUrlOptions();
  if (!hadFile || reset) await resetSample();
  initSyncSim();
  render();
  document.body.dataset.ready = "1";
}

start();

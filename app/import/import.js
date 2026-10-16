// The Google Keep import (`<web app>/import/`, no link from the app;
// docs/requirements.md → "Import from Google Keep"): reads a Google Takeout
// ZIP in the browser, shows every note as it will look in NoteDown, all
// selected except those without text; a tap on a card deselects it, and
// "Import n notes" asks once more before the notes go into the private file
// of this browser's NoteDown (an open app tab follows, sync uploads them).
// `?sample` previews app/sample/keep.json instead of a file.
import { readKeepZip, keepNotes, toNoteDown, droppedText } from "../js/core/keep-import.js";
import { renderMarkdown } from "../js/core/markdown.js";
import { fillMedia } from "../js/ui/external.js";
import { state, load, importNotes } from "../js/store.js";
import { initConfirm, openConfirm } from "../js/ui/confirm.js";
import { relativeTime } from "../js/ui/format.js";
import { icon } from "../js/ui/icons.js";

const $ = id => document.getElementById(id);
const FLAVORS = ["latte", "frappe", "macchiato", "mocha"];
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

let items = [];          // [{ note (core/keep-import.js → keepNote), on }]
let trashed = 0;

function applyTheme() {
  const wanted = state.settings.flavor;
  document.documentElement.dataset.flavor = FLAVORS.includes(wanted) ? wanted : systemDark.matches ? "mocha" : "latte";
}

function show(step) {
  for (const id of ["pickStep", "previewStep", "doneStep"]) $(id).hidden = id !== step;
  $("actionBar").hidden = step !== "previewStep";
  window.scrollTo(0, 0);
}

// ---------- picking the file ----------

async function readFile(file) {
  $("pickError").hidden = true;
  try {
    const result = await readKeepZip(new Uint8Array(await file.arrayBuffer()));
    if (!result.notes.length) throw new Error("No Keep notes in this file. Export Keep alone from Google Takeout and choose that ZIP.");
    preview(result);
  } catch (err) {
    $("pickError").textContent = /not a zip|broken zip/.test(err.message) ? "This is not a ZIP file from Google Takeout." : err.message;
    $("pickError").hidden = false;
  }
}

function preview(result) {
  items = result.notes.map(note => ({ note, on: note.hasText }));
  trashed = result.trashed;
  $("list").replaceChildren(...items.map(card));
  show("previewStep");
  refresh();
}

// ---------- preview ----------

function card(item, i) {
  const n = item.note;
  const el = document.createElement("article");
  el.className = "note imp-card" + (n.status === "closed" ? " archived" : "") + (n.hasText ? "" : " no-text");
  el.dataset.i = i;
  const body = document.createElement("div");
  body.className = "note-body md";
  if (n.hasText) {
    body.innerHTML = renderMarkdown(n.body);
    body.querySelectorAll("input.task").forEach(cb => (cb.disabled = true));
    body.querySelectorAll("a").forEach(a => a.setAttribute("tabindex", "-1"));
    body.querySelectorAll(".ext-media").forEach(el => fillMedia(el, "never"));   // a preview loads nothing
  } else {
    body.innerHTML = `<p class="imp-nothing">Only ${esc(droppedText(n.dropped))} — nothing to import.</p>`;
  }
  const meta = document.createElement("div");
  meta.className = "note-meta";
  const chips = [];
  if (n.status === "closed") chips.push(`<span class="chip">${icon("archive")}To the archive</span>`);
  if (n.status === "permanent") chips.push(`<span class="chip">${icon("permanent")}Permanent</span>`);
  if (n.hasText && Object.keys(n.dropped).length) chips.push(`<span class="chip imp-lost">${esc(droppedText(n.dropped))} not imported</span>`);
  if (n.shared) chips.push(`<span class="chip">Shared in Keep · imported as private</span>`);
  chips.push(`<span>Edited ${esc(relativeTime(n.modified))}</span>`);
  meta.innerHTML = chips.join("");
  const check = document.createElement("span");
  check.className = "imp-check";
  check.setAttribute("role", "checkbox");
  check.innerHTML = icon("check");
  el.append(body, meta, check);
  if (n.hasText) {
    el.tabIndex = 0;
    el.addEventListener("click", e => { if (!e.target.closest("a")) toggle(i); });
    el.addEventListener("keydown", e => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(i); } });
  }
  return el;
}

function toggle(i) {
  items[i].on = !items[i].on;
  refresh();
}

function setAll(on) {
  for (const it of items) it.on = on && it.note.hasText;
  refresh();
}

function refresh() {
  [...$("list").children].forEach((el, i) => {
    el.classList.toggle("selected", items[i].on);
    el.querySelector(".imp-check").setAttribute("aria-checked", String(items[i].on));
  });
  const n = items.filter(it => it.on).length;
  const count = status => items.filter(it => it.note.status === status).length;
  const parts = [plural(items.length, "note") + " from Keep"];
  if (count("closed")) parts.push(`${count("closed")} archived`);
  if (count("permanent")) parts.push(`${count("permanent")} pinned → permanent`);
  if (trashed) parts.push(`${trashed} in Keep's trash left out`);
  $("summary").textContent = parts.join(" · ");
  $("count").textContent = `${n} of ${items.length}`;
  $("importBtn").textContent = n ? `Import ${plural(n, "note")}` : "Import";
  $("importBtn").disabled = !n;
}

function confirmImport() {
  const chosen = items.filter(it => it.on).map(it => it.note);
  openConfirm({
    title: `Import ${plural(chosen.length, "note")}?`,
    text: "They go to your private notes in this browser, archived ones to the archive. With sync on, your other devices get them too.",
    danger: false,
    okLabel: () => "Import",
    onConfirm: () => {
      load();   // the newest state, should the app have changed it meanwhile
      importNotes(chosen.map(toNoteDown));
      $("doneText").textContent = `${plural(chosen.length, "note")} imported`;
      show("doneStep");
    },
  });
}

// ---------- wiring ----------

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function start() {
  load();
  applyTheme();
  systemDark.addEventListener("change", applyTheme);
  initConfirm();
  $("chooseBtn").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", e => { const f = e.target.files[0]; e.target.value = ""; if (f) readFile(f); });
  // Drag and drop (desktop); the whole page takes the file.
  const drop = $("drop");
  document.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
  document.addEventListener("dragleave", e => { if (!e.relatedTarget) drop.classList.remove("over"); });
  document.addEventListener("drop", e => {
    e.preventDefault();
    drop.classList.remove("over");
    const f = e.dataTransfer.files[0];
    if (f && !$("pickStep").hidden) readFile(f);
  });
  $("allBtn").addEventListener("click", () => setAll(true));
  $("noneBtn").addEventListener("click", () => setAll(false));
  $("otherBtn").addEventListener("click", () => show("pickStep"));
  $("importBtn").addEventListener("click", confirmImport);
  if (new URLSearchParams(location.search).has("sample")) {
    const { files } = await (await fetch(new URL("../sample/keep.json", import.meta.url))).json();
    preview(keepNotes(files.map(f => ({ name: f.name, text: JSON.stringify(f.json) }))));
  }
  document.body.dataset.ready = "1";
}

start();

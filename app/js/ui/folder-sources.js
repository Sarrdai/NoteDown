// Folder sources (docs/requirements.md → "Folder sources"): Settings → Data → Folder sources lists them, adds
// one (Android app: a name and a folder) and renames, re-points or removes one. The Android app reads every
// folder of this device when it starts, when it comes back to the front and every few minutes while it is
// open: each new file becomes a private note of its source (core/folder-source.js), then the file is
// deleted. Which folder a source reads is a setting of this device; the sources themselves are synced.
import { state, updateSettings, sources, addSource, renameSource, removeSource, addSourceNotes } from "../store.js";
import { fileNote, isNoteFile } from "../core/folder-source.js";
import { registerPage, go, popPage, refreshPage, row, section, panelPage } from "./sync-panel.js";
import { openConfirm } from "./confirm.js";
import { expectReturn } from "./app-lock.js";
import { showSnackbar } from "./snackbar.js";
import { isAndroidApp, nativeApp, folderPlugin } from "../platform.js";
import { h, button } from "./dom.js";

const EVERY_MS = 5 * 60 * 1000;   // while the app is open
const folderOf = id => state.settings.folders[id] || null;

function setFolder(id, folder) {
  const folders = { ...state.settings.folders };
  if (folder) folders[id] = folder;
  else delete folders[id];
  updateSettings({ folders });
}

/** The line under "Folder sources" in the settings: the names, or None. */
export const sourcesSummary = () => sources().map(s => s.name).join(", ") || "None";

/** Whether the settings show the row: in the Android app, or elsewhere once there is a source to rename or remove. */
export const showSourcesRow = () => isAndroidApp() || sources().length > 0;

const folderSub = id => {
  const f = folderOf(id);
  return !f ? (isAndroidApp() ? "No folder on this device" : "Read by the Android app") : f.lost ? "Folder access lost, choose it again" : f.label;
};

// ---------- reading the folders ----------

let running = false;

/** Reads every folder of this device once: new files become notes of their source, then go away. */
export async function importFolders() {
  const plugin = folderPlugin();
  if (!plugin || running) return;
  running = true;
  try {
    for (const s of sources()) {
      const f = folderOf(s.id);
      if (f?.uri) await importFolder(plugin, s, f);
    }
  } finally {
    running = false;
  }
}

async function importFolder(plugin, source, f) {
  let files;
  try {
    ({ files } = await plugin.list({ uri: f.uri }));
  } catch (err) {
    if (err?.code === "no-access" && !f.lost) setFolder(source.id, { ...f, lost: true });
    return;
  }
  if (f.lost) setFolder(source.id, { ...f, lost: false });
  // A file that couldn't be deleted is remembered by name and time, so it isn't read twice.
  const skip = new Set(f.skip || []);
  const fresh = files.filter(x => isNoteFile(x.name) && !skip.has(`${x.id}@${x.modified}`))
    .sort((a, b) => b.modified - a.modified);
  if (!fresh.length) return;
  const items = fresh.map(x => fileNote(x.text, x.modified)).filter(x => x.body);
  if (items.length) addSourceNotes(source.id, items);
  const kept = [];
  for (const x of fresh) {
    try { await plugin.remove({ uri: f.uri, id: x.id }); } catch { kept.push(`${x.id}@${x.modified}`); }
  }
  if (kept.length) setFolder(source.id, { ...folderOf(source.id), skip: [...(f.skip || []), ...kept].slice(-200) });
  if (items.length) showSnackbar(items.length === 1 ? `Note added from ${source.name}` : `${items.length} notes added from ${source.name}`);
}

/** Reads the folders now, when the Android app comes back to the front and every few minutes while it shows. */
export function initFolderSources() {
  if (!folderPlugin()) return;
  importFolders();
  if (nativeApp) nativeApp.addListener("appStateChange", ({ isActive }) => { if (isActive) importFolders(); });
  setInterval(() => { if (document.visibilityState === "visible") importFolders(); }, EVERY_MS);
}

// Opens the system's folder picker; → { uri, label } or null when the user backed out.
async function pickFolder() {
  expectReturn();
  try {
    return await folderPlugin().pick();
  } catch (err) {
    if (err?.code !== "cancelled") showSnackbar("Couldn't open the folder");
    return null;
  }
}

// ---------- settings pages ----------

const intro = () => h("p", { class: "sheet-text muted" },
  "Notes another app writes into a folder, e.g. voice notes from the Pebble app. The Android app reads each file into a private note and deletes the file. Its notes show under the source's name in People, on all your devices.");

registerPage("settingsSources", {
  title: "Folder sources",
  render: () => [
    intro(),
    sources().length ? h("ul", { class: "sheet-card" }, [...sources()].sort((a, b) => a.name.localeCompare(b.name)).map(s =>
      row({ icon: "folder", title: s.name, sub: folderSub(s.id), open: () => go("settingsSource", { id: s.id }) }))) : null,
    isAndroidApp() ? h("div", { class: "sheet-actions" }, button("Add folder source", "outline", () => go("settingsSourceNew", { name: "" }))) : null,
  ],
});

function nameInput(data, onChange, onEnter) {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, "Name"),
    h("input", {
      type: "text", class: "input", autocomplete: "off", autocapitalize: "words", spellcheck: "false", maxlength: "40",
      "aria-label": "Name", value: data.name, "data-autofocus": true,
      oninput: e => { data.name = e.target.value; onChange(); },
      onkeydown: e => { if (e.key === "Enter" && onEnter) onEnter(); },
    }),
    h("span", { class: "field-hint" }, "Shown in People, e.g. the app that writes the files."));
}

registerPage("settingsSourceNew", {
  title: "Add folder source",
  render: data => {
    const choose = button("Choose folder", "primary", async () => {
      const name = data.name.trim();
      if (!name) return;
      const folder = await pickFolder();
      if (!folder) return;
      const source = addSource(name);
      setFolder(source.id, { uri: folder.uri, label: folder.label });
      if (panelPage() === "settingsSourceNew") popPage();
      importFolders();
    });
    choose.disabled = !data.name.trim();
    return [
      nameInput(data, () => { choose.disabled = !data.name.trim(); }, () => choose.click()),
      h("p", { class: "sheet-text muted" }, "Choose the folder the other app writes into. NoteDown deletes each file once its note is added."),
      h("div", { class: "sheet-actions" }, choose),
    ];
  },
});

registerPage("settingsSource", {
  title: data => sources().find(s => s.id === data.id)?.name || "Folder source",
  render: data => {
    const s = sources().find(x => x.id === data.id);
    if (!s) return [h("p", { class: "sheet-text muted" }, "This source was removed.")];
    data.name ??= s.name;
    const save = () => { const name = data.name.trim(); if (name && name !== s.name) renameSource(s.id, name); };
    const input = nameInput(data, () => {}, save);
    input.querySelector("input").addEventListener("change", save);
    return [
      input,
      section("Folder"),
      h("ul", { class: "sheet-card" }, isAndroidApp()
        ? row({ icon: "folder", title: folderOf(s.id) ? "Choose another folder" : "Choose folder", sub: folderSub(s.id), open: async () => {
          const folder = await pickFolder();
          if (!folder) return;
          setFolder(s.id, { uri: folder.uri, label: folder.label });
          refreshPage({ keepScroll: true });
          importFolders();
        } })
        : row({ icon: "folder", title: "Folder", sub: "Read by the Android app that has it set" })),
      h("div", { class: "sheet-actions" }, button("Remove source", "danger", () => openConfirm({
        title: `Remove ${s.name}?`,
        text: "Its folder isn't read any more. The notes read from it stay as private notes.",
        okLabel: () => "Remove",
        onConfirm: () => { setFolder(s.id, null); removeSource(s.id); popPage(); },
      }))),
    ];
  },
});

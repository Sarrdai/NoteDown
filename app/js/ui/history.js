// Version history (docs/requirements.md → "Version history", backlog #7): the older states the server keeps of
// the private file and the shared files, in the Sync & sharing panel. Only shown for files that keep a history
// (a member has it switched on by the server's owner). A state is opened, compared with now and restored for
// everyone in the file. The sample (`?sample`) derives its states from the sample notes (sample/sharing.json →
// `history`). A state shows what restoring it changes (decided 2026-10-15 over showing its notes as they were:
// it answers which state is the right one and what a restore would lose). "Back up now" saves the current state of
// every such file at once, kept like the others for 30 days but never thinned out.
import { state, sharedFiles, setPrivateFile, setSharedFile } from "../store.js";
import { parseNotesFile } from "../core/notes-file.js";
import { renderMarkdown, noteTitle } from "../core/markdown.js";
import { restoredFile, restoredNote, compareStates, changeSummary, stateTime } from "../core/history.js";
import { fileVersions, fileVersionText, restoreFileVersion, backUpNow, syncNow as syncReal } from "../sync/client.js";
import { syncNow as simulatedSync } from "../sync-sim.js";
import { loadSharingSample } from "../sample.js";
import { registerPage, addOverviewSection, go, popPage, refreshPage, isPanelOpen, panelData, row, section } from "./sync-panel.js";
import { circleName } from "./people-list.js";
import { openConfirm } from "./confirm.js";
import { showSnackbar } from "./snackbar.js";
import { h, text, button } from "./dom.js";
import { fillWatches } from "./counter.js";
import { applyExternal } from "./external.js";

const real = () => !state.sync.simulated;
const fileOf = slot => (slot === "" ? state.file : sharedFiles().find(s => s.key === slot)?.file);
const nameOf = slot => (slot === "" ? "Private" : circleName(slot));

// ---------- where the states come from ----------

let sampleSpec = null;            // sample/sharing.json → history: { [slot]: [{ hoursAgo, without, restore, shorter, pinned }] }
const sampleStates = new Map();   // slot → [{ version, replaced, pinned, saved, file }], newest first, made on first use
const texts = new Map();          // "<slot>/<version>" → parsed file (real mode)

/** The files with a version history: real, the ones the server lists so; the sample, the ones its data names. */
export function historySlots() {
  const slots = real() ? state.sync.history : Object.keys(sampleSpec || {});
  return slots.filter(slot => fileOf(slot));
}

// An older state of the sample: the file as it is now, without the notes added since, with the ones trashed
// since back, and with only the first half of the lines of the ones edited since.
function sampleState(current, spec) {
  const without = new Set(spec.without || []), restore = new Set(spec.restore || []), shorter = new Set(spec.shorter || []);
  const notes = current.notes.filter(n => !without.has(n.id)).map(n => {
    if (restore.has(n.id)) { const { deleted, kept, ...rest } = n; return rest; }
    if (shorter.has(n.id)) { const lines = n.body.trim().split("\n"); return { ...n, body: lines.slice(0, Math.ceil(lines.length / 2)).join("\n") }; }
    return n;
  });
  return { ...current, notes };
}

async function versionsOf(slot) {
  if (real()) return fileVersions(slot);
  if (!sampleStates.has(slot)) {
    const now = Date.now();
    sampleStates.set(slot, (sampleSpec[slot] || []).map((spec, i, all) => ({
      version: all.length - i, replaced: new Date(now - spec.hoursAgo * 3600000).toISOString(), pinned: Boolean(spec.pinned),
      saved: false, file: sampleState(fileOf(slot), spec),
    })));
  }
  return sampleStates.get(slot);
}

async function stateOf(slot, version) {
  if (!real()) return sampleStates.get(slot).find(v => v.version === version).file;
  const key = `${slot}/${version}`;
  if (!texts.has(key)) texts.set(key, parseNotesFile(await fileVersionText(slot, version)));
  return texts.get(key);
}

async function restore(slot, version) {
  if (real()) return restoreFileVersion(slot, version);
  const list = sampleStates.get(slot), current = fileOf(slot);
  const file = restoredFile(current, list.find(v => v.version === version).file);
  list.unshift({ version: list[0] ? list[0].version + 1 : 1, replaced: new Date().toISOString(), pinned: true, saved: false, file: current });
  if (slot === "") setPrivateFile(file);
  else setSharedFile(slot.split("+"), file);
  await simulatedSync();
}

// "Back up now" → how many files got a new state. The sample saves a state unless the newest one is a backup of
// the same notes.
async function backUp() {
  if (real()) return backUpNow();
  let saved = 0;
  for (const slot of historySlots()) {
    const list = await versionsOf(slot), current = fileOf(slot);
    if (list[0]?.saved && JSON.stringify(list[0].file) === JSON.stringify(current)) continue;
    list.unshift({ version: list[0] ? list[0].version + 1 : 1, replaced: new Date().toISOString(), pinned: true, saved: true, file: structuredClone(current) });
    saved++;
  }
  return saved;
}

let backingUp = false;
async function backUpClicked() {
  if (backingUp) return;
  backingUp = true;
  showSnackbar("Backing up…");
  try {
    const saved = await backUp();
    showSnackbar(saved ? "Backed up. The state stays in the version history for 30 days." : "Already backed up: nothing changed since the last backup.");
  } catch (e) {
    showSnackbar(`Couldn't back up: ${e.message}`);
  } finally {
    backingUp = false;
  }
}

// ---------- the overview's section ----------

// The "Version history" section of the Sync & sharing overview: only while a file keeps one.
addOverviewSection(() => {
  if (!real() && !sampleSpec) loadSharingSample().then(s => { sampleSpec = s.history || {}; if (isPanelOpen()) refreshPage(); });
  if (!historySlots().length) return null;
  return [
    section("Version history"),
    h("ul", { class: "sheet-card" }, row({
      icon: "restore", title: "Older states of your notes", sub: "Kept on the server for 30 days", open: () => go("history"),
    }), row({
      icon: "cloudCheck", title: "Back up now", sub: "Keeps the current state of all your notes", open: backUpClicked,
    })),
  ];
});

// ---------- pages ----------

// `slot`: the file's circle, whose setting decides on links and media (ui/external.js).
const noteCard = (note, cls, slot, onRestore) => {
  const { text: title } = noteTitle(note.body);
  const body = h("div", { class: "history-note-body md", html: renderMarkdown(note.body) });
  applyExternal(body, slot);
  fillWatches(body);
  if (!onRestore) return h("li", { class: "history-note " + cls, "aria-label": title }, body);
  return h("li", { class: "history-note-item" }, h("div", { class: "history-note " + cls, "aria-label": title }, body),
    button("Restore this note", "history-note-restore", () => onRestore(note)));
};

function noteGroup(title, notes, cls, slot, onRestore) {
  if (!notes.length) return null;
  return [section(`${title} (${notes.length})`), h("ul", { class: "history-notes" }, notes.map(n => noteCard(n, cls, slot, onRestore)))];
}

const stateTitle = v => stateTime(v.replaced) + (v.saved ? " · backed up" : v.pinned ? " · before a restore" : "");

registerPage("history", {
  title: "Version history",
  render: () => [
    text("The server keeps older states of your notes for 30 days: one per hour for the last day, then one per day. Pick a file to see them."),
    h("ul", { class: "sheet-card" }, historySlots().map(slot => row({
      icon: slot === "" ? "lock" : "share", title: nameOf(slot), sub: slot === "" ? "Your private notes" : "Shared notes",
      open: () => go("historyFile", { slot }),
    }))),
  ],
});

registerPage("historyFile", {
  title: data => nameOf(data.slot),
  render: data => {
    if (!data.versions && !data.loading) {
      data.loading = true;
      versionsOf(data.slot)
        .then(v => { data.versions = v; })
        .catch(e => { data.failed = e.message; })
        .finally(() => { data.loading = false; if (isPanelOpen() && panelData() === data) refreshPage(); });
    }
    if (!data.versions) return [text(data.failed ? `Couldn't load the older states: ${data.failed}` : "Loading…", "sheet-text muted")];
    if (!data.versions.length) return [text("No older states yet. They appear once these notes change.", "sheet-text muted")];
    data.subs ||= new Map();
    // Each row's line needs the state's notes: read one after the other, the list redraws as they come.
    if (!data.reading) {
      data.reading = (async () => {
        for (const v of data.versions) {
          try {
            const old = await stateOf(data.slot, v.version);
            data.subs.set(v.version, changeSummary(compareStates(fileOf(data.slot), old)));
          } catch (e) {
            data.subs.set(v.version, "Couldn't be read");
          }
          if (isPanelOpen() && panelData() === data) refreshPage({ keepScroll: true });
        }
      })();
    }
    return [
      text(data.slot === ""
        ? "Each state is how your private notes were at that time. Restoring one brings back its notes; the state it replaces stays here."
        : `Each state is how the notes shared with ${nameOf(data.slot)} were at that time. Restoring one changes them for everyone in it.`),
      h("ul", { class: "sheet-card" }, data.versions.map(v => row({
        icon: "notes", title: stateTitle(v), sub: data.subs.get(v.version) || "…",
        open: () => go("historyState", { slot: data.slot, version: v, list: data }),
      }))),
    ];
  },
});

registerPage("historyState", {
  title: data => stateTime(data.version.replaced),
  render: data => {
    if (!data.old && !data.failed) {
      stateOf(data.slot, data.version.version)
        .then(old => { data.old = old; }, e => { data.failed = e.message; })
        .finally(() => { if (isPanelOpen() && panelData() === data) refreshPage(); });
      return [text("Loading…", "sheet-text muted")];
    }
    if (data.failed) return [text(`Couldn't read this state: ${data.failed}`, "field-error")];
    const head = data.version.saved ? [text("You backed up this state by hand.", "sheet-text muted")]
      : data.version.pinned ? [text("This is how the notes were right before a restore.", "sheet-text muted")] : [];
    const diff = compareStates(fileOf(data.slot), data.old);
    if (!diff.back.length && !diff.gone.length && !diff.changed.length) return [...head, text("Same notes as now: restoring changes nothing.")];
    return [
      ...head,
      text("What restoring this state changes:"),
      noteGroup("Come back", diff.back, "back", data.slot, n => restoreNote(data, n)),
      noteGroup("Go, added since", diff.gone, "gone", data.slot),
      diff.changed.length ? [section(`Changed (${diff.changed.length})`), text("They go back to this text:", "sheet-text muted"),
        h("ul", { class: "history-notes" }, diff.changed.map(c => noteCard(c.before, "changed", data.slot, n => restoreNote(data, n))))] : null,
      diff.same ? text(`${diff.same} ${diff.same === 1 ? "note stays" : "notes stay"} as they are.`, "sheet-text muted") : null,
    ].flat();
  },
  footer: data => data.old ? [button("Restore this state", "primary", () => confirmRestore(data))] : [],
});

const syncAfterEdit = () => (!state.sync.enabled ? Promise.resolve() : real() ? syncReal().catch(() => {}) : simulatedSync());
const writeFile = (slot, file) => (slot === "" ? setPrivateFile(file) : setSharedFile(slot.split("+"), file));

// One note back from the state, no confirmation: Undo puts the file as it was back. Written like a note edit, so
// it syncs as one (in a shared file for everyone in it).
async function restoreNote(data, note) {
  const before = fileOf(data.slot);
  writeFile(data.slot, restoredNote(before, data.old, note.id));
  refreshPage({ keepScroll: true });
  await syncAfterEdit();
  showSnackbar("Note restored", async () => {
    writeFile(data.slot, before);
    refreshPage({ keepScroll: true });
    await syncAfterEdit();
  });
}

function confirmRestore(data) {
  const when = stateTime(data.version.replaced);
  openConfirm({
    title: "Restore this state?",
    text: data.slot === ""
      ? `Your private notes go back to ${when}. The state now stays in the version history, so you can undo this.`
      : `The notes shared with ${nameOf(data.slot)} go back to ${when}, for everyone in it. The state now stays in the version history, so you can undo this.`,
    okLabel: () => "Restore",
    danger: false,
    onConfirm: async () => {
      try {
        await restore(data.slot, data.version.version);
      } catch (e) {
        showSnackbar(e.message);
        return;
      }
      // Back to the list, loaded again with the new state on top.
      popPage();
      Object.assign(data.list, { versions: null, subs: null, reading: null, loading: false, failed: null });
      refreshPage();
      showSnackbar("State restored");
    },
  });
}

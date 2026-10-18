// Settings → Data → Backup (backlog #56, docs/requirements.md → "Encrypted backup"): the backup page, the page
// that shows a new backup key once, and restoring a backup file. The file's format and the choice of what to
// restore are core/backup.js. Pages live in the settings container (ui/sync-panel.js).
import { state, updateSettings, addRestoredNotes, noteIds } from "../store.js";
import { getSecret, setSecret } from "../sync/keystore.js";
import {
  generateBackupKey, normalizeBackupKey, backupContents, sealBackup, openBackup, notesToRestore, backupFileName, BackupError,
} from "../core/backup.js";
import { shareFilePlugin } from "../platform.js";
import { registerPage, refreshPage, go, popPage, resetPanel, action, panelPage } from "./sync-panel.js";
import { openConfirm } from "./confirm.js";
import { showSnackbar } from "./snackbar.js";
import { expectReturn } from "./app-lock.js";
import { today, fullDate } from "./format.js";
import { icon } from "./icons.js";
import { h, text, button } from "./dom.js";

let hasKey = false;   // whether this device has a backup key (read again each time the page is drawn)

// What a backup leaves out of the settings: this device's own protection and its last backup.
const withoutDevice = ({ lock, privacy, lastBackup, ...rest }) => rest;

const base64 = bytes => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

// Android: the share sheet (save to Drive, files, mail …). Web: a download.
async function save(name, bytes) {
  const share = shareFilePlugin();
  if (share) {
    expectReturn();
    try { await share.share({ name, data: base64(bytes), type: "application/octet-stream" }); } catch { throw new Error("Saving the backup failed."); }
    return;
  }
  const a = h("a", { href: URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function makeBackup(key) {
  const now = new Date();
  const contents = backupContents({ file: state.file, shared: state.shared, settings: withoutDevice(state.settings) }, now.toISOString());
  await save(backupFileName(today(now)), await sealBackup(contents, key));
  updateSettings({ lastBackup: now.toISOString() });
  showSnackbar("Backup saved");
}

// "Create backup": the first one needs a key, which is shown once.
async function createBackup() {
  const key = await getSecret("backup");
  if (!key) { go("settingsBackupKey", { key: generateBackupKey() }); return; }
  await makeBackup(key);
  refreshPage({ keepScroll: true });
}

function pickFile() {
  const input = h("input", { type: "file", class: "visually-hidden", "aria-hidden": "true", tabindex: "-1" });
  input.addEventListener("change", async () => {
    const file = input.files[0];
    input.remove();
    if (!file) return;
    const deviceKey = await getSecret("backup").catch(() => null);   // the key this device backs up with, if any
    go("settingsRestore", { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), key: "", deviceKey: normalizeBackupKey(deviceKey) || "", keep: true });
  });
  document.body.append(input);
  expectReturn();
  input.click();
}

registerPage("settingsBackup", {
  title: "Backup",
  render: data => {
    getSecret("backup").then(k => { if (!!k !== hasKey) { hasKey = !!k; if (panelPage() === "settingsBackup") refreshPage({ keepScroll: true }); } }).catch(() => {});
    const { btn, error } = action("Create backup", createBackup);
    const last = state.settings.lastBackup;
    return [
      text("A backup is one file with all your notes and settings, encrypted. Save it where you like — only your backup key opens it. It holds no keys of your sync identity, so restoring it never links a device."),
      h("div", { class: "sheet-actions" }, btn, button("Restore from a backup", "outline", pickFile)),
      error,
      text(last ? `Last backup: ${fullDate(last)}` : "No backup made on this device yet", "sheet-text muted"),
      hasKey && button("New backup key", "text-action", () => openConfirm({
        title: "New backup key?", text: "Backups you made before still need the old key.", okLabel: () => "New key", danger: false,
        onConfirm: () => go("settingsBackupKey", { key: generateBackupKey() }),
      })),
    ];
  },
});

async function copy(value) {
  try { await navigator.clipboard.writeText(value); return true; } catch { return false; }
}

registerPage("settingsBackupKey", {
  title: "Your backup key",
  render: data => {
    const saved = h("input", { type: "checkbox", id: "backupKeySaved" });
    const { btn: done, error } = action("Create backup", async () => {
      const digits = normalizeBackupKey(data.key);
      await setSecret("backup", digits);
      await makeBackup(digits);
      popPage();
    });
    done.disabled = true;
    saved.addEventListener("change", () => { done.disabled = !saved.checked; });
    return [
      text("Write these 30 digits down or keep them in a password manager. Without them no one can open your backups — NoteDown can't show them again."),
      h("div", { class: "key-box", role: "group", "aria-label": "Backup key " + data.key },
        data.key.split(" ").map(g => h("span", { class: "key-group" }, g))),
      h("div", { class: "button-row" },
        h("button", { class: "btn outline", type: "button",
          onclick: async () => showSnackbar(await copy(data.key) ? "Backup key copied" : "Copying is blocked here") },
        h("span", { html: icon("copy") }), "Copy")),
      h("label", { class: "check-row" }, saved, h("span", {}, "I have stored the backup key")),
      h("div", { class: "sheet-actions" }, done),
      error,
    ];
  },
});

// Restoring adds the backup's notes this device doesn't have, as private notes (core/backup.js → notesToRestore).
async function restore(data) {
  let contents;
  try { contents = await openBackup(data.bytes, data.key); } catch (e) {
    throw e instanceof BackupError ? e : new BackupError("This file couldn't be read as a backup.");
  }
  // The key opened the backup: keep it for later backups when asked (backlog #62), exactly like a created one.
  const digits = normalizeBackupKey(data.key);
  if (data.keep && digits && digits !== data.deviceKey) { await setSecret("backup", digits); data.deviceKey = digits; data.kept = true; }
  const notes = notesToRestore(contents, noteIds());
  if (notes.length) addRestoredNotes(notes);
  const { lock, privacy, lastBackup, ...settings } = contents.settings || {};
  if (Object.keys(settings).length) updateSettings(settings);
  data.result = notes.length;
}

registerPage("settingsRestore", {
  title: "Restore from a backup",
  render: data => {
    if (data.result !== undefined) {
      return [
        data.kept && text("This backup key is now the key for your future backups."),
        text(data.result
          ? `${data.result === 1 ? "1 note" : `${data.result} notes`} restored — they are private notes on this device; with sync on they go to your other devices too.`
          : "Nothing to restore — every note of this backup is here already."),
        h("div", { class: "sheet-actions" }, button("Done", "primary", () => resetPanel("settings"))),
      ];
    }
    const { btn, error } = action("Restore", async () => { await restore(data); refreshPage(); });
    // The offer (backlog #62) shows while the typed key is a full key this device doesn't back up with.
    const keep = h("input", { type: "checkbox", id: "backupKeyKeep", checked: data.keep, onchange: e => { data.keep = e.target.checked; } });
    const offer = h("label", { class: "check-row" }, keep, h("span", {}, data.deviceKey
      ? "Keep this backup key for future backups. It replaces this device's current key; backups made with the old key still need the old key."
      : "Keep this backup key for future backups"));
    const sync = () => { btn.disabled = !data.key.trim(); const d = normalizeBackupKey(data.key); offer.hidden = !d || d === data.deviceKey; };
    sync();
    const input = h("input", {
      type: "text", class: "input mono", inputmode: "numeric", autocomplete: "off", spellcheck: "false", "data-autofocus": true,
      "aria-label": "Backup key", value: data.key, placeholder: "30 digits",
      oninput: e => { data.key = e.target.value; sync(); },
      onkeydown: e => { if (e.key === "Enter" && !btn.disabled) btn.click(); },
    });
    return [
      h("p", { class: "file-name" }, data.name),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Backup key"), input),
      offer,
      error,
      h("div", { class: "sheet-actions" }, btn),
    ];
  },
});

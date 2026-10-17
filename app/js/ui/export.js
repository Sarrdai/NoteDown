// Export (⋮ → "Export…", and Export in the selection bar): "This view" as one
// Markdown file in the order the list shows, "All files" as a ZIP with one
// Markdown file per NoteDown file (private + one per circle), or the selected
// parts in contents order. Options: include the archive, a table of contents
// on top, keep the hidden note markers (core/export.js). The choices are
// remembered on this device.
import { state, updateSettings } from "../store.js";
import { exportMarkdown, zipFiles } from "../core/export.js";
import { today } from "./format.js";
import { showSnackbar } from "./snackbar.js";
import { Capacitor, registerPlugin } from "../../vendor/capacitor-core.esm.js";

// The Android app's own plugin (mobile/…/ShareFilePlugin.java): the web view ignores downloads.
const NativeShare = Capacitor.isNativePlatform() ? registerPlugin("ShareFile") : null;

const $ = id => document.getElementById(id);
let source = null;   // { selection } or { view, files, archiveInView }
let scope = "view";

/**
 * `src`: `{ items, label }` for a selection; otherwise `{ view(archive) → groups,
 * files(archive) → [{ name, groups }], count, archiveInView }` (the archive
 * option only shows where it adds something: All files, or This view in the
 * main view).
 */
export function openExport(src) {
  source = src;
  scope = "view";
  const sel = !!src.items;
  $("exportTitle").textContent = sel ? `Export ${src.label}` : "Export";
  $("exportHint").textContent = sel ? "As one Markdown file, in the order of the contents." : "";
  $("exportHint").hidden = !sel;
  $("exportScope").hidden = sel;
  if (!sel) {
    $("exportScope").innerHTML = choice("view", "This view", `${src.count === 1 ? "1 note" : `${src.count} notes`} as shown, one Markdown file`, true)
      + choice("files", "All files", src.fileCount === 1 ? "Your notes as a ZIP with one Markdown file" : `A ZIP with one Markdown file each: private and ${src.fileCount - 1} shared`, false);
  }
  const o = state.settings.exportOptions;
  $("exportArchive").checked = o.archive;
  $("exportToc").checked = o.toc;
  $("exportMeta").checked = o.metadata;
  renderArchiveRow();
  $("exportDialog").hidden = false;
  $("exportOk").focus({ preventScroll: true, focusVisible: false });
}

const choice = (value, title, hint, checked) =>
  `<label class="choice"><input type="radio" name="exportScope" value="${value}"${checked ? " checked" : ""}>`
  + `<span class="choice-text"><span class="choice-title">${title}</span><span class="choice-hint">${hint}</span></span></label>`;

function renderArchiveRow() {
  $("exportArchiveRow").hidden = !!source.items || (scope === "view" && source.archiveInView);
}

const closeDialog = () => { $("exportDialog").hidden = true; source = null; };

function run() {
  const opts = { archive: $("exportArchive").checked, toc: $("exportToc").checked, metadata: $("exportMeta").checked };
  updateSettings({ exportOptions: opts });
  const md = { ...opts, depth: state.settings.tocDepth };
  const name = `NoteDown-${today()}`;
  if (source.items) save(`${name}.md`, exportMarkdown([{ items: source.items }], md), "text/markdown");
  else if (scope === "view") save(`${name}.md`, exportMarkdown(source.view(opts.archive), md), "text/markdown");
  else {
    const files = source.files(opts.archive).map(f => ({ name: f.name, text: exportMarkdown(f.groups, md) }));
    save(`${name}.zip`, zipFiles(files), "application/zip");
  }
  closeDialog();
}

// Web: a download. The Android app hands the file to the system's share sheet.
function save(name, data, type) {
  if (NativeShare) {
    NativeShare.share({ name, type, data: base64(typeof data === "string" ? new TextEncoder().encode(data) : data) })
      .catch(() => showSnackbar("Export failed"));
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  showSnackbar(`Exported ${name}`);
}

function base64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function initExport() {
  $("exportScope").addEventListener("change", e => { scope = e.target.value; renderArchiveRow(); });
  $("exportCancel").addEventListener("click", closeDialog);
  $("exportOk").addEventListener("click", run);
  $("exportDialog").addEventListener("click", e => { if (e.target === $("exportDialog")) closeDialog(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("exportDialog").hidden) { e.stopPropagation(); closeDialog(); } }, true);
}

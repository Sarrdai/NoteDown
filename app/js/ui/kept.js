// A kept note: a protected shared note the others deleted, kept here in the
// private file and still shown in its circle (docs/sync-and-sharing.md →
// "Files"). Changing it stays on this device; only "Restore for …" shares it
// with the circle again (after asking), and "Keep as my own note" makes it a
// plain private note.
import { note, keptCircle, restoreKept, keepAsOwn } from "../store.js";
import { membersLabel, avatarStackHtml, esc } from "./people.js";
import { openMenu } from "./menu.js";
import { openConfirm } from "./confirm.js";
import { showSnackbar } from "./snackbar.js";
import { icon } from "./icons.js";

/** The marker in the meta line: the circle's avatars, crossed out, and "Deleted"; a tap offers the actions. */
export function keptMarkerHtml(n) {
  const label = membersLabel(n.kept.split("+"));
  return `<button type="button" class="shared-mark kept-mark" aria-label="${esc(`Deleted for ${label}, kept here. Options`)}">`
    + `${avatarStackHtml(n.kept.split("+"))}<span class="kept-label">Deleted</span></button>`;
}

/** The bar at the top of a kept card (variant B): what happened and both actions as text buttons. */
export function keptBanner(n) {
  const el = document.createElement("div");
  el.className = "kept-banner";
  el.innerHTML = `<span class="kept-text">${icon("protect")}<span>Deleted for ${esc(membersLabel(n.kept.split("+")))} · kept here</span></span>`
    + `<span class="kept-actions"><button type="button" class="link-btn" data-act="restore">Restore…</button>`
    + `<button type="button" class="link-btn" data-act="own">Keep as my own</button></span>`;
  el.addEventListener("click", e => {
    const act = e.target.closest("button")?.dataset.act;
    if (act === "restore") confirmRestore(n.id);
    else if (act === "own") keepOwn(n.id);
  });
  return el;
}

export function openKeptMenu(anchor, id) {
  const label = membersLabel(keptCircle(id));
  openMenu(anchor, [
    { section: `Deleted for ${label} · kept here` },
    { label: `Restore for ${label}…`, icon: "share", onSelect: () => confirmRestore(id) },
    { label: "Keep as my own note", icon: "lock", onSelect: () => keepOwn(id) },
  ]);
}

function confirmRestore(id) {
  const label = membersLabel(keptCircle(id));
  if (!note(id) || !label) return;
  openConfirm({
    title: `Restore for ${label}?`,
    text: `It was deleted for ${label}. Restoring shares it with them again, with every change you made since.`,
    okLabel: () => "Restore",
    danger: false,
    onConfirm: () => showSnackbar(`Restored for ${label}`, restoreKept(id)),
  });
}

function keepOwn(id) {
  showSnackbar("Kept as your own note", keepAsOwn(id));
}

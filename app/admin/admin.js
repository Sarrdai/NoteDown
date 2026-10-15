// The admin dashboard of the server owner (`<web host>/admin/`): what the server stores,
// the identities with devices and files, a storage limit per identity, backup and restore.
// Signs in with this browser's linked device, like the app does; `?sample` runs on
// app/sample/admin.json without a network. Logic without DOM access: app/js/core/admin.js.
//
// Three sections, Overview / Identities / Backup: a nav rail with list and detail side by side on the
// desktop, tabs with the detail as a page of its own on tablet and phone.
import { h } from "../js/ui/dom.js";
import { icon } from "../js/ui/icons.js";
import { openMenu, initMenu } from "../js/ui/menu.js";
import { showSnackbar } from "../js/ui/snackbar.js";
import { createApi } from "../js/sync/api.js";
import { getSecret } from "../js/sync/keystore.js";
import { serverUrl } from "../js/core/linking.js";
import {
  formatBytes, usageText, meterText, shortId, usageLevel, plural, formatDate, cardMeta, fileScope, sortIdentities,
  defaultDirection, parseQuotaInput, quotaInputText, readBackup, backupSummaryText, restoreErrorText, createSampleAdmin,
} from "../js/core/admin.js";

const FLAVORS = ["latte", "frappe", "macchiato", "mocha"];
const params = new URLSearchParams(location.search);
const $ = id => document.getElementById(id);

// ---------- state ----------

const S = {
  sample: params.has("sample"),
  status: "loading",       // loading | ready | no-sync | not-admin | error
  error: "",
  host: "", identity: "",  // the server's host, the caller's identity ID
  overview: null, identities: [],
  details: new Map(),      // identity ID → detail, or { error }
  sort: { key: "updated", dir: "desc" },
  section: "overview",     // overview | identities | backup
  open: null,              // the identity ID shown beside the list (desktop) or as a page
  tier: "desktop",
  busy: false,
};
let api = null;

const readStore = key => { try { return localStorage.getItem(key); } catch { return null; } };
const readJson = key => { try { return JSON.parse(readStore(key) || "null"); } catch { return null; } };

// ---------- theme and tier ----------

const systemDark = matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const wanted = params.get("flavor") || (readJson("notedown.settings") || {}).flavor || "system";
  const flavor = FLAVORS.includes(wanted) ? wanted : systemDark.matches ? "mocha" : "latte";
  document.documentElement.dataset.flavor = flavor;
}

const desktopMQ = matchMedia("(min-width: 1024px)");
const tabletMQ = matchMedia("(min-width: 600px)");
const tierNow = () => (desktopMQ.matches ? "desktop" : tabletMQ.matches ? "tablet" : "phone");

// ---------- sign-in ----------

async function connect() {
  if (S.sample) {
    const data = await (await fetch(new URL("../sample/admin.json", import.meta.url))).json();
    api = createSampleAdmin(data);
    S.host = "sample server";
    S.identity = data.overview.identity;
    return true;
  }
  const sync = readJson("notedown.sync");
  const keys = sync && sync.enabled && sync.identity && !sync.simulated ? await getSecret("device").catch(() => null) : null;
  if (!keys || !keys.sign || !sync.device) { S.status = "no-sync"; return false; }
  let config = {};
  try { config = await (await fetch(new URL("../config.json", import.meta.url), { cache: "no-store" })).json(); } catch { /* none */ }
  const raw = sync.server || params.get("api") || readStore("notedown.api") || config.api;
  const server = raw && serverUrl(new URL(raw, location.href).href);
  if (!server) {
    S.status = "error";
    S.error = "No sync server is set up for this browser.";
    return false;
  }
  S.identity = sync.identity;
  S.host = new URL(server).host;
  api = createApi(server, () => ({ identity: sync.identity, device: sync.device, sign: keys.sign.privateKey }));
  return true;
}

// ---------- data ----------

async function loadAll() {
  S.busy = true;
  if (!S.overview) S.status = "loading";
  render();
  try {
    const [overview, list] = await Promise.all([api.adminOverview(), api.adminIdentities()]);
    S.overview = overview;
    S.identities = list.identities;
    S.details.clear();
    S.status = "ready";
    if (S.open && !S.identities.some(i => i.id === S.open)) S.open = null;
  } catch (e) {
    if (e.status === 404) S.status = "not-admin";
    else { S.status = "error"; S.error = e.message || "Something went wrong."; }
  }
  S.busy = false;
  render();
  if (S.status === "ready") loadOpenDetail();
}

async function loadDetail(id) {
  try {
    S.details.set(id, await api.adminIdentity(id));
  } catch (e) {
    S.details.set(id, { error: e.message || "Something went wrong." });
  }
  render();
}

const shownId = () => S.open || (S.tier === "desktop" && S.section === "identities" ? sorted()[0]?.id : null);
function loadOpenDetail() {
  const id = shownId();
  if (id && !S.details.has(id)) loadDetail(id);
}

/** After a changed limit: the list (storage bar, marker) and the open detail. */
async function reloadIdentity(id) {
  S.details.delete(id);
  try {
    S.identities = (await api.adminIdentities()).identities;
  } catch (e) {
    showSnackbar(e.message);
  }
  render();
  loadOpenDetail();
}

const sorted = () => sortIdentities(S.identities, S.sort.key, S.sort.dir);

// ---------- small views ----------

/** An icon as an element (`icon()` gives markup). */
function ico(name, cls) {
  const t = document.createElement("template");
  t.innerHTML = icon(name, cls);
  return t.content.firstElementChild;
}

const mono = (s, cls = "") => h("span", { class: ("mono " + cls).trim() }, s);

function youChip() {
  return h("span", { class: "adm-chip you" }, "You");
}

function meter(used, quota) {
  const u = usageLevel(used, quota);
  return h("div", {
    class: "meter", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(u.percent),
    "aria-label": "Storage used", "data-level": u.level,
  }, h("div", { class: "meter-fill", style: `width: ${u.percent}%` }));
}

function storageBlock(i) {
  return h("div", { class: "c-storage" },
    meter(i.used, i.quota),
    h("div", { class: "su-text" },
      h("span", {}, usageText(i.used, i.quota)),
      i.quota_override !== null && h("span", { class: "adm-chip custom" }, "Custom limit")));
}

async function copyText(value, message) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const ta = h("textarea", { style: "position: fixed; opacity: 0", "aria-hidden": "true" });
    ta.value = value;
    document.body.append(ta);
    ta.select();
    try { document.execCommand("copy"); } catch { /* nothing to do */ }
    ta.remove();
  }
  showSnackbar(message);
}

const copyButton = id => h("button", { class: "btn outline", type: "button", onclick: () => copyText(id, "ID copied.") }, ico("copy"), "Copy ID");

function download(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------- header ----------

function header() {
  return h("header", { class: "adm-top" },
    h("div", { class: "adm-wrap adm-top-row" },
      h("div", { class: "adm-brand" },
        h("h1", {}, "NoteDown Admin"),
        S.host && h("span", { class: "adm-host" }, S.host),
        S.sample && h("span", { class: "adm-chip sample" }, "Sample data")),
      h("div", { class: "adm-actions" },
        S.status === "ready" || S.status === "loading" ? h("button", {
          class: "btn outline adm-refresh", type: "button", "data-key": "refresh", disabled: S.busy, onclick: loadAll,
        }, ico("refresh"), h("span", { class: "adm-refresh-label" }, "Refresh")) : null,
        h("button", { class: "icon-btn", type: "button", id: "moreBtn", "data-key": "more", "aria-haspopup": "menu", "aria-label": "More", title: "More", html: icon("more"), onclick: moreMenu }))),
    S.status === "ready" && S.tier !== "desktop" && h("div", { class: "adm-wrap" }, nav()));
}

function moreMenu(e) {
  openMenu(e.currentTarget, [
    { label: "Open NoteDown", onSelect: () => { location.href = "../"; } },
  ]);
}

// ---------- navigation ----------

const SECTIONS = [["overview", "Overview", "notes"], ["identities", "Identities", "user"], ["backup", "Backup", "cloud"]];

function nav() {
  return h("nav", { class: "adm-nav", role: "tablist", "aria-label": "Sections" },
    SECTIONS.map(([id, label, ic]) => h("button", {
      class: "adm-nav-item", type: "button", role: "tab", "data-key": "nav-" + id, "aria-selected": String(S.section === id),
      onclick: () => { S.section = id; S.open = null; render(); loadOpenDetail(); window.scrollTo(0, 0); },
    }, ico(ic), h("span", {}, label))));
}

// ---------- overview ----------

function tile(label, value, sub) {
  return h("div", { class: "adm-tile" },
    h("div", { class: "tile-label" }, label),
    h("div", { class: "tile-value" }, String(value)),
    sub && h("div", { class: "tile-sub" }, sub));
}

function overviewSection() {
  const { counts, storage } = S.overview;
  const db = usageLevel(storage.database, storage.database_limit);
  return h("section", { class: "adm-section", "aria-labelledby": "h-overview" },
    h("h2", { class: "adm-h", id: "h-overview" }, "Overview"),
    h("div", { class: "adm-tiles" },
      tile("Identities", counts.identities),
      tile("Devices", counts.devices),
      tile("Files", counts.files, `${counts.shared_files} shared`),
      tile("Contacts", counts.contacts),
      tile("Open invitations", counts.invitations),
      h("div", { class: "adm-tile adm-meter" },
        h("div", { class: "tile-label" }, "Database"),
        h("div", { class: "tile-value small" }, meterText(storage.database, storage.database_limit)),
        h("div", {
          class: "meter", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(db.percent),
          "aria-label": "Database size", "data-level": db.level,
        }, h("div", { class: "meter-fill", style: `width: ${Math.max(db.percent, storage.database > 0 ? 1 : 0)}%` })),
        h("div", { class: "tile-sub" }, `Encrypted notes: ${formatBytes(storage.files)}`))));
}

// ---------- identities ----------

// How the rows look: a table (tablet) or cards (phone, and the narrow list beside the detail on the desktop).
const rowStyle = () => (S.tier === "tablet" ? "table" : "cards");

const COLUMNS = [["id", "ID"], ["devices", "Devices"], ["files", "Files"], ["used", "Storage"], ["updated", "Last change"]];

function sortBy(key) {
  S.sort = S.sort.key === key ? { key, dir: S.sort.dir === "asc" ? "desc" : "asc" } : { key, dir: defaultDirection(key) };
  render();
}

function listHead() {
  return h("div", { class: "adm-head", role: "group", "aria-label": "Columns" },
    COLUMNS.map(([key, label]) => {
      const active = S.sort.key === key;
      return h("button", {
        class: "adm-sort", type: "button", "data-key": "sort-" + key, "data-active": String(active),
        "aria-label": `Sort by ${label}`, "aria-pressed": String(active), onclick: () => sortBy(key),
      }, label, active && ico(S.sort.dir === "asc" ? "up" : "down"));
    }));
}

function select(id) {
  S.open = id;
  if (S.tier !== "desktop") S.listScroll = window.scrollY;
  render();
  loadOpenDetail();
  if (S.tier !== "desktop") window.scrollTo(0, 0);
}

function openIdentity(id) {
  S.open = id;
  render();
  loadOpenDetail();
  window.scrollTo(0, 0);
}

function row(i, style, selected) {
  const key = "row-" + i.id;
  const id = h("span", { class: "c-id" }, ico("down", "icon chevron"), mono(shortId(i.id)), i.id === S.identity && youChip());
  const cells = style === "cards"
    ? [id, storageBlock(i), h("span", { class: "c-meta" }, cardMeta(i))]
    : [id,
      h("span", { class: "c-num" }, i.devices), h("span", { class: "c-num" }, i.files),
      storageBlock(i),
      h("span", { class: "c-updated" }, formatDate(i.updated))];
  return h("div", {
    class: "adm-row " + style, role: "button", tabindex: "0", "data-key": key,
    "aria-current": String(selected),
    onclick: () => select(i.id),
    onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(i.id); } },
  }, cells);
}

function identityList() {
  const style = rowStyle();
  const current = shownId();
  return h("div", { class: "adm-listwrap" },
    style === "table" && listHead(),
    h("ul", { class: "adm-list " + style },
      sorted().map(i => h("li", { class: "adm-item" + (current === i.id ? " open" : "") },
        row(i, style, current === i.id)))));
}

function identitiesSection() {
  const head = h("h2", { class: "adm-h", id: "h-identities" }, "Identities", h("span", { class: "count" }, String(S.identities.length)));
  if (S.tier === "desktop") {
    return h("section", { class: "adm-section", "aria-labelledby": "h-identities" }, head,
      h("div", { class: "adm-split" }, identityList(), h("div", { class: "adm-pane" }, detailView(shownId()))));
  }
  if (S.open) {
    return h("section", { class: "adm-section", "aria-label": "Identity" },
      h("button", {
        class: "adm-back", type: "button", "data-key": "back",
        onclick: () => { S.open = null; render(); window.scrollTo(0, S.listScroll || 0); },
      }, ico("back"), "Identities"),
      detailView(S.open));
  }
  return h("section", { class: "adm-section", "aria-labelledby": "h-identities" }, head, identityList());
}

// ---------- identity detail ----------

function detailView(id) {
  if (!id) return h("div", { class: "adm-detail" }, h("p", { class: "adm-muted" }, "No identities yet."));
  const d = S.details.get(id);
  if (!d) return h("div", { class: "adm-detail" }, h("p", { class: "adm-muted" }, "Loading…"));
  if (d.error) {
    return h("div", { class: "adm-detail" }, h("p", { class: "field-error" }, d.error),
      h("button", { class: "btn outline", type: "button", onclick: () => { S.details.delete(id); render(); loadDetail(id); } }, "Try again"));
  }
  const defaultQuota = S.overview.quota;
  return h("div", { class: "adm-detail" },
    h("div", { class: "d-card" },
      h("div", { class: "d-idrow" },
        h("div", { class: "d-id" }, mono(d.id, "full"), d.id === S.identity && youChip()),
        copyButton(d.id)),
      h("div", { class: "d-facts" }, h("span", {}, "Created"), h("strong", {}, formatDate(d.created, { time: true })))),
    h("div", { class: "d-card" },
      h("h4", { class: "d-title" }, "Storage"),
      storageBlock(d),
      quotaForm(d, defaultQuota)),
    h("div", { class: "d-grid" },
      h("div", { class: "d-card" },
        h("h4", { class: "d-title" }, "Devices"),
        d.devices.length ? h("ul", { class: "d-list" }, d.devices.map(dev => h("li", { class: dev.active ? "" : "removed" },
          mono(shortId(dev.id)),
          h("span", { class: "d-kind" }, dev.kind === "recovery" ? "Recovery" : "Device"),
          h("span", { class: "adm-chip " + (dev.active ? "active" : "gone") }, dev.active ? "Active" : "Removed")))) : h("p", { class: "adm-muted" }, "None")),
      h("div", { class: "d-card" },
        h("h4", { class: "d-title" }, "Files"),
        d.files.length ? h("ul", { class: "d-list files" }, d.files.map(f => h("li", {},
          mono(shortId(f.id)),
          h("span", { class: "d-kind" }, fileScope(f.members)),
          h("span", { class: "d-meta" }, `v${f.version} · ${formatBytes(f.size)} · updated ${formatDate(f.updated)}`)))) : h("p", { class: "adm-muted" }, "No files"))),
    h("div", { class: "d-card" },
      h("h4", { class: "d-title" }, "Contacts"),
      d.contacts.length ? h("div", { class: "d-contacts" }, d.contacts.map(c => h("button", {
        class: "adm-chip contact", type: "button", "aria-label": `Open identity ${shortId(c)}`, onclick: () => openIdentity(c),
      }, mono(shortId(c))))) : h("p", { class: "adm-muted" }, "No contacts"),
      h("p", { class: "d-invites" }, `Open invitations: ${d.invitations}`)));
}

function quotaForm(d, defaultQuota) {
  const input = h("input", {
    class: "input", type: "number", step: "any", min: "0", inputmode: "decimal", id: "quota-input", "data-key": "quota",
    placeholder: quotaInputText(defaultQuota), value: quotaInputText(d.quota_override),
  });
  const error = h("p", { class: "field-error", hidden: true });
  const save = h("button", { class: "btn primary", type: "submit" }, "Save");
  const reset = d.quota_override !== null && h("button", { class: "btn outline", type: "button" }, `Reset to default (${formatBytes(defaultQuota)})`);

  async function apply(quota) {
    save.disabled = true;
    if (reset) reset.disabled = true;
    try {
      await api.adminSetQuota(d.id, quota);
      showSnackbar(quota === null ? "Storage limit reset to default." : "Storage limit saved.");
      await reloadIdentity(d.id);
    } catch (e) {
      error.textContent = e.message || "Could not save the limit.";
      error.hidden = false;
      save.disabled = false;
      if (reset) reset.disabled = false;
    }
  }
  if (reset) reset.addEventListener("click", () => apply(null));
  return h("form", {
    class: "d-quota", novalidate: true,
    onsubmit: e => {
      e.preventDefault();
      const r = parseQuotaInput(input.value);
      error.hidden = !r.error;
      error.textContent = r.error || "";
      if (!r.error) apply(r.quota);
    },
  },
  h("label", { class: "field-label", for: "quota-input" }, "Storage limit"),
  h("div", { class: "d-qrow" },
    h("div", { class: "adm-unit" }, input, h("span", {}, "MB")),
    save, reset),
  h("p", { class: "field-hint" }, `Leave empty for the default (${formatBytes(defaultQuota)}).`),
  error);
}

// ---------- backup ----------

async function downloadBackup(btn) {
  btn.disabled = true;
  try {
    const { text, filename } = await api.adminBackup();
    download(text, filename);
    showSnackbar("Backup downloaded.");
  } catch (e) {
    showSnackbar(e.message || "Could not download the backup.");
  }
  btn.disabled = false;
}

function backupSection() {
  const dl = h("button", { class: "btn primary", type: "button", onclick: () => downloadBackup(dl) }, ico("download"), "Download backup");
  return h("section", { class: "adm-section", "aria-labelledby": "h-backup" },
    h("h2", { class: "adm-h", id: "h-backup" }, "Backup"),
    h("div", { class: "adm-card" },
      h("p", { class: "adm-text" }, "A snapshot of everything the server stores: encrypted notes, public keys, who shares with whom. No note text is readable."),
      h("div", { class: "button-row" },
        dl,
        h("button", { class: "btn outline", type: "button", "data-key": "restore", onclick: () => { $("restoreFile").value = ""; $("restoreFile").click(); } }, ico("reopen"), "Restore backup…"))));
}

let dialogCleanup = null;

function closeDialog() {
  if (dialogCleanup) dialogCleanup();
}

/** The restore dialog for the chosen file: its summary and the confirmation, or why it can't be used. */
async function openRestoreDialog(file) {
  closeDialog();
  let result;
  try { result = readBackup(await file.text()); } catch { result = { error: "The file could not be read." }; }
  const trigger = document.activeElement;
  const cancel = h("button", { class: "btn", type: "button", onclick: closeDialog }, "Cancel");
  const restore = h("button", { class: "btn primary danger", type: "button", disabled: true }, "Restore");
  const error = h("p", { class: "field-error", hidden: true });
  let body, input = null;
  if (result.error) {
    body = [h("p", { class: "dialog-hint" }, file.name), h("p", { class: "field-error show" }, result.error)];
  } else {
    input = h("input", { class: "input mono", id: "restore-confirm", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-describedby": "restore-warning" });
    body = [
      h("p", { class: "dialog-hint strong" }, backupSummaryText(result.summary)),
      h("p", { class: "adm-warning", id: "restore-warning" },
        "Replaces everything on the server with this backup. Devices linked after the backup must be linked again. Notes edited since then come back from the devices when they sync."),
      h("label", { class: "field adm-confirm" }, h("span", { class: "field-label" }, "Type RESTORE to confirm"), input),
      error,
    ];
    input.addEventListener("input", () => { restore.disabled = input.value.trim() !== "RESTORE"; });
    input.addEventListener("keydown", e => { if (e.key === "Enter" && !restore.disabled) restore.click(); });
    restore.addEventListener("click", async () => {
      restore.disabled = cancel.disabled = input.disabled = true;
      restore.textContent = "Restoring…";
      try {
        await api.adminRestore(result.backup);
      } catch (e) {
        error.textContent = restoreErrorText(e.status, e.body) || e.message || "The restore failed.";
        error.hidden = false;
        restore.textContent = "Restore";
        cancel.disabled = input.disabled = false;
        restore.disabled = input.value.trim() !== "RESTORE";
        return;
      }
      closeDialog();
      showSnackbar("Backup restored.");
      loadAll();
    });
  }
  const dialog = h("div", { class: "dialog adm-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "restore-title" },
    h("h2", { class: "dialog-title", id: "restore-title" }, "Restore backup"),
    ...body,
    h("div", { class: "dialog-actions" }, cancel, result.error ? null : restore));
  const scrim = h("div", { class: "dialog-scrim", onclick: e => { if (e.target === scrim && !cancel.disabled) closeDialog(); } }, dialog);
  const onKey = e => {
    if (e.key === "Escape" && !cancel.disabled) { e.preventDefault(); closeDialog(); }
    if (e.key === "Tab") {   // keep the focus inside
      const items = [...dialog.querySelectorAll("input, button")].filter(el => !el.disabled);
      if (!items.length) return;
      const first = items[0], last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener("keydown", onKey);
  document.body.append(scrim);
  dialogCleanup = () => {
    document.removeEventListener("keydown", onKey);
    scrim.remove();
    dialogCleanup = null;
    if (trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
  };
  (input || cancel).focus({ preventScroll: true });
}

// ---------- states without data ----------

function stateCard(...kids) {
  return h("main", { class: "adm-wrap adm-main" }, h("div", { class: "adm-state" }, ...kids));
}

function statesView() {
  if (S.status === "loading") return stateCard(h("p", { class: "adm-muted center" }, "Loading…"));
  if (S.status === "no-sync") {
    return stateCard(
      h("h2", {}, "Sync is not turned on in this browser."),
      h("p", { class: "adm-text" }, "Open NoteDown in this browser, turn on sync or link this browser to your devices, then come back."),
      h("a", { class: "btn primary", href: "../" }, "Open NoteDown"));
  }
  if (S.status === "not-admin") {
    return stateCard(
      h("h2", {}, `This identity is not an admin of ${S.host}.`),
      h("div", { class: "d-idrow" }, mono(S.identity, "full boxed"), copyButton(S.identity)),
      h("p", { class: "adm-text" }, "Add the ID to the repository variable ", h("code", {}, "ADMIN_IDENTITIES"), " and deploy the server (docs/operations.md)."));
  }
  return stateCard(
    h("h2", {}, S.error),
    h("button", { class: "btn primary", type: "button", onclick: start }, "Try again"));
}

// ---------- page ----------

function content() {
  const section = S.section === "overview" ? overviewSection() : S.section === "identities" ? identitiesSection() : backupSection();
  if (S.tier === "desktop") return h("div", { class: "adm-wrap adm-shell" }, nav(), h("main", { class: "adm-main" }, section));
  return h("div", { class: "adm-wrap" }, h("main", { class: "adm-main" }, section));
}

function render() {
  const root = $("admin");
  S.tier = tierNow();
  const focused = document.activeElement && root.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  root.className = `admin tier-${S.tier}`;
  root.replaceChildren(header(), S.status === "ready" ? content() : statesView());
  if (focused) root.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  document.body.dataset.ready = "1";
}

async function start() {
  S.status = "loading";
  S.overview = null;
  render();
  if (await connect()) await loadAll();
  else render();
}

applyTheme();
systemDark.addEventListener("change", applyTheme);
initMenu();
$("restoreFile").addEventListener("change", e => { const f = e.target.files[0]; if (f) openRestoreDialog(f); });
for (const mq of [desktopMQ, tabletMQ]) mq.addEventListener("change", () => { if (S.status !== "loading") render(); });
start();

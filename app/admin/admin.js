// The admin dashboard of the server owner (`<web host>/admin/`): what the server stores,
// the identities with devices and files, a storage limit per identity, backup and restore.
// Signs in with this browser's linked device, like the app does; `?sample` runs on
// app/sample/admin.json without a network, and `?api=` names another server (both on a local address only,
// platform.js → prototypeSwitches). Logic without DOM access: app/js/core/admin.js.
//
// Four sections, Overview / Identities / News / Backup: a nav rail with list and detail side by side on the
// desktop, tabs with the detail as a page of its own on tablet and phone.
import { h } from "../js/ui/dom.js";
import { icon } from "../js/ui/icons.js";
import { openMenu, initMenu } from "../js/ui/menu.js";
import { showSnackbar } from "../js/ui/snackbar.js";
import { createEditor } from "../js/ui/editor.js";
import { relativeTime } from "../js/ui/format.js";
import { createApi } from "../js/sync/api.js";
import { getSecret } from "../js/sync/keystore.js";
import { readStored } from "../js/vault.js";
import { serverUrl } from "../js/core/linking.js";
import { prototypeSwitches } from "../js/platform.js";
import { deviceKeysFromSeeds } from "../js/core/crypto.js";
import { renderMarkdown } from "../js/core/markdown.js";
import { fillMedia } from "../js/ui/external.js";
import { parseNotesFile } from "../js/core/notes-file.js";
import {
  formatBytes, usageText, meterText, shortId, usageLevel, plural, formatDate, cardMeta, fileScope, sortIdentities, filterIdentities,
  defaultDirection, parseQuotaInput, quotaInputText, parseMembersInput, DEFAULT_MEMBERS, readBackup, backupSummaryText, restoreErrorText, createSampleAdmin,
  NEW_POST_TEXT, checkNewsBody, newsErrorText, newsDateText, splitNews, newsFromNotes, blockText, parseBlockUntil,
} from "../js/core/admin.js";

const FLAVORS = ["latte", "frappe", "macchiato", "mocha"];
const params = new URLSearchParams(location.search);
const $ = id => document.getElementById(id);

// ---------- state ----------

const S = {
  sample: prototypeSwitches && params.has("sample"),
  status: "loading",       // loading | ready | no-sync | not-admin | error
  error: "",
  host: "", identity: "",  // the server's host, the caller's identity ID
  overview: null, identities: [],
  details: new Map(),      // identity ID → detail, or { error }
  news: [],                // every post, archived ones included, as the server lists them
  newsEdit: null,          // the post being written: { id (null = a new one), el, editor, text, initial }
  sort: { key: "updated", dir: "desc" },
  query: "",               // the search field of the identity list (kept while switching sections)
  section: "overview",     // overview | identities | news | backup
  open: null,              // the identity ID shown beside the list (desktop) or as a page
  tier: "desktop",
  busy: false,
};
let api = null;

const readStore = key => { try { return localStorage.getItem(key); } catch { return null; } };
// The app's settings and sync state, from the encrypted vault (app/js/vault.js).
const readJson = async key => { try { return JSON.parse((await readStored(key)) || "null"); } catch { return null; } };

// ---------- theme and tier ----------

const systemDark = matchMedia("(prefers-color-scheme: dark)");
let storedFlavor = "";
function applyTheme() {
  const wanted = params.get("flavor") || storedFlavor || "system";
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
    const posts = await (await fetch(new URL("../sample/news.md", import.meta.url))).text();
    api = createSampleAdmin(data, newsFromNotes(parseNotesFile(posts).notes));
    S.host = "sample server";
    S.identity = data.overview.identity;
    return true;
  }
  const sync = await readJson("notedown.sync");
  // The vault keeps the device keys' seeds (sync/client.js → readKeys); the keys are imported from them.
  const seeds = sync && sync.enabled && sync.identity && !sync.simulated ? await getSecret("device").catch(() => null) : null;
  const keys = seeds ? await deviceKeysFromSeeds(seeds).catch(() => null) : null;
  if (!keys || !keys.sign || !sync.device) { S.status = "no-sync"; return false; }
  let config = {};
  try { config = await (await fetch(new URL("../config.json", import.meta.url), { cache: "no-store" })).json(); } catch { /* none */ }
  const raw = sync.server || (prototypeSwitches && (params.get("api") || readStore("notedown.api"))) || config.api;
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
    const [overview, list, news] = await Promise.all([api.adminOverview(), api.adminIdentities(), api.adminNews()]);
    S.overview = overview;
    S.identities = list.identities;
    S.news = news.news;
    dropVanishedEdit();
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

/** After a changed limit, history switch or block: the overview, the list (storage bar, markers) and the open detail. */
async function reloadIdentity(id) {
  S.details.delete(id);
  try {
    const [overview, list] = await Promise.all([api.adminOverview(), api.adminIdentities()]);
    S.overview = overview;
    S.identities = list.identities;
  } catch (e) {
    showSnackbar(e.message);
  }
  render();
  loadOpenDetail();
}

const sorted = () => sortIdentities(filterIdentities(S.identities, S.query), S.sort.key, S.sort.dir);

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

const historyChip = () => h("span", { class: "adm-chip history" }, "History");
const blockedChip = () => h("span", { class: "adm-chip blocked" }, "Blocked");

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
  // id "topbar": the editor keeps the caret clear of it (ui/editor.js).
  return h("header", { class: "adm-top", id: "topbar" },
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

const SECTIONS = [["overview", "Overview", "notes"], ["identities", "Identities", "user"], ["news", "News", "news"], ["backup", "Backup", "cloud"]];

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
  // The host's limit is a server setting (DATABASE_LIMIT_MB); null while it isn't set.
  const limitSet = storage.database_limit != null;
  const db = usageLevel(storage.database, storage.database_limit);
  return h("section", { class: "adm-section", "aria-labelledby": "h-overview" },
    h("h2", { class: "adm-h", id: "h-overview" }, "Overview"),
    h("div", { class: "adm-tiles" },
      tile("Identities", counts.identities, counts.blocked ? `${counts.blocked} blocked` : null),
      tile("Devices", counts.devices),
      tile("Files", counts.files, `${counts.shared_files} shared`),
      tile("Contacts", counts.contacts),
      tile("Open invitations", counts.invitations),
      h("div", { class: "adm-tile adm-meter" },
        h("div", { class: "tile-label" }, "Database", infoTip("db-limit", "About the database limit", limitSet
          ? `The limit (${formatBytes(storage.database_limit)}) is set on the server with DATABASE_LIMIT_MB; the server can't ask the database host for it. ` +
            "Neon's free plan has 1024 MB. Change it when the plan or the host changes."
          : "The server can't ask the database host for its size limit, so it reads it from DATABASE_LIMIT_MB, which isn't set. " +
            "Set it to the plan's limit in MB (Neon's free plan: 1024) and deploy the server again.")),
        h("div", { class: "tile-value small" }, limitSet ? meterText(storage.database, storage.database_limit) : formatBytes(storage.database)),
        limitSet ? h("div", {
          class: "meter", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(db.percent),
          "aria-label": "Database size", "data-level": db.level,
        }, h("div", { class: "meter-fill", style: `width: ${Math.max(db.percent, storage.database > 0 ? 1 : 0)}%` }))
          : h("div", { class: "tile-sub tile-warn" }, "Limit not set (DATABASE_LIMIT_MB)"),
        h("div", { class: "tile-sub" }, `Encrypted notes: ${formatBytes(storage.files)}`),
        storage.history > 0 && h("div", { class: "tile-sub" }, `Version history: ${formatBytes(storage.history)}`))),
    h("div", { class: "d-card adm-limits" },
      h("h3", { class: "d-title" }, "Group size"),
      h("p", { class: "adm-muted d-note" }, "The most people a new group can have, its creator included. Existing groups keep their members."),
      membersForm({
        id: "members-all", override: S.overview.max_members_override, fallback: DEFAULT_MEMBERS,
        hint: `Leave empty for the default (${DEFAULT_MEMBERS}).`, resetLabel: `Reset to default (${DEFAULT_MEMBERS})`,
        save: max => api.adminSetMaxMembers(max),
        // Every identity without an override of its own follows it.
        done: () => { S.details.clear(); return reloadIdentity(null); },
      })));
}

/** An (i) button with a hint that shows on hover and keyboard focus, and on a tap on touch screens. */
function infoTip(id, label, text) {
  const btn = h("button", {
    class: "adm-info", type: "button", "aria-label": label, "aria-describedby": id, "aria-expanded": "false",
    onclick: () => btn.setAttribute("aria-expanded", String(btn.getAttribute("aria-expanded") !== "true")),
    onblur: () => btn.setAttribute("aria-expanded", "false"),
  }, ico("info", "icon"));
  return h("span", { class: "adm-infowrap" }, btn, h("span", { class: "adm-tip", role: "tooltip", id }, text));
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
  const id = h("span", { class: "c-id" }, ico("down", "icon chevron"), mono(shortId(i.id)), i.id === S.identity && youChip(), i.history && historyChip(), i.blocked && blockedChip());
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

/** The search field above the list; the list below it follows while typing (the field itself stays, with its focus). */
function searchBar() {
  const clear = h("button", {
    class: "icon-btn adm-search-clear", type: "button", "data-key": "search-clear", "aria-label": "Clear search", title: "Clear search",
    html: icon("close"), hidden: !S.query,
    onclick: () => { input.value = ""; input.focus(); searchChanged(input, clear); },
  });
  const input = h("input", {
    class: "input adm-search-input", type: "text", id: "identity-search", "data-key": "search", placeholder: "Search by ID", value: S.query,
    "aria-label": "Search by ID", autocomplete: "off", autocapitalize: "off", spellcheck: "false", enterkeyhint: "search",
    oninput: () => searchChanged(input, clear),
  });
  return h("div", { class: "adm-search", role: "search" }, ico("search", "icon adm-search-icon"), input, clear);
}

function searchChanged(input, clear) {
  S.query = input.value;
  clear.hidden = !S.query;
  document.querySelector(".adm-results")?.replaceWith(identityResults());
  const pane = document.querySelector(".adm-pane");   // desktop: the detail shows the first row until one is picked
  if (pane && !S.open) { pane.replaceChildren(detailView(shownId())); loadOpenDetail(); }
}

function identityResults() {
  const style = rowStyle();
  const current = shownId();
  const list = sorted();
  return h("div", { class: "adm-results" },
    list.length > 0 && style === "table" && listHead(),
    list.length > 0
      ? h("ul", { class: "adm-list " + style },
        list.map(i => h("li", { class: "adm-item" + (current === i.id ? " open" : "") },
          row(i, style, current === i.id))))
      : S.query.trim() && h("p", { class: "adm-muted adm-nomatch" }, `No identity matches \u201c${S.query.trim()}\u201d.`));
}

function identityList() {
  return h("div", { class: "adm-listwrap" }, searchBar(), identityResults());
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
  if (!id) return h("div", { class: "adm-detail" }, h("p", { class: "adm-muted" }, S.identities.length ? "No identity to show." : "No identities yet."));
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
    h("div", { class: "d-card" },
      h("h4", { class: "d-title" }, "Group size"),
      h("p", { class: "d-note" }, `New groups this identity creates can have up to ${d.max_members} people.`),
      membersForm({
        id: "members-input", override: d.max_members_override, fallback: S.overview.max_members,
        hint: `Leave empty for the server-wide limit (${S.overview.max_members}).`, resetLabel: `Reset to server-wide (${S.overview.max_members})`,
        save: max => api.adminSetIdentityMaxMembers(d.id, max), done: () => reloadIdentity(d.id),
      })),
    historyCard(d),
    accessCard(d),
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

/** The "Version history" switch: an extra feature per identity that the owner unlocks by hand. */
function historyCard(d) {
  const input = h("input", {
    class: "switch", type: "checkbox", role: "switch", id: "history-switch", "data-key": "history",
    checked: !!d.history, "aria-labelledby": "history-title", "aria-describedby": "history-sub",
  });
  const error = h("p", { class: "field-error", hidden: true });
  input.addEventListener("change", async () => {
    const on = input.checked;
    input.disabled = true;
    error.hidden = true;
    try {
      await api.adminSetHistory(d.id, on);
      showSnackbar(on ? "Version history switched on." : "Version history switched off.");
      await reloadIdentity(d.id);
    } catch (e) {
      input.checked = !on;
      input.disabled = false;
      error.textContent = e.message || "Could not change the version history.";
      error.hidden = false;
    }
  });
  return h("div", { class: "d-card d-history" },
    h("div", { class: "d-switchrow" },
      h("label", { class: "d-switchtext", for: "history-switch" },
        h("span", { class: "d-switchtitle", id: "history-title" }, "Version history"),
        h("span", { class: "d-switchsub", id: "history-sub" }, "Keeps older states of this identity\u2019s files for 30 days, shared files included.")),
      input),
    d.history && h("p", { class: "d-historysize" }, `History uses ${formatBytes(d.history_size)}`),
    error);
}

/** Blocking and deleting the identity (backlog #34). The owner's own identity can be neither. */
function accessCard(d) {
  const title = h("h4", { class: "d-title" }, "Access");
  if (d.id === S.identity) return h("div", { class: "d-card d-access" }, title, h("p", { class: "adm-muted" }, "Your own identity can't be blocked or deleted."));
  const lift = async btn => {
    btn.disabled = true;
    try {
      await api.adminBlock(d.id, false);
      showSnackbar("Block lifted.");
      await reloadIdentity(d.id);
    } catch (e) {
      btn.disabled = false;
      showSnackbar(e.message || "Could not lift the block.");
    }
  };
  const blockButton = d.blocked
    ? h("button", { class: "btn outline", type: "button", "data-key": "lift", onclick: e => lift(e.currentTarget) }, "Lift block")
    : h("button", { class: "btn outline", type: "button", "data-key": "block", onclick: () => openBlockDialog(d) }, "Block\u2026");
  return h("div", { class: "d-card d-access" },
    title,
    d.blocked
      ? h("p", { class: "d-accesstext" }, h("span", { class: "adm-chip blocked" }, blockText(d.blocked_until)), " Its devices can't sync. Nothing is deleted.")
      : h("p", { class: "d-accesstext" }, "Its devices sync normally."),
    h("div", { class: "d-actions" }, blockButton,
      h("button", { class: "btn outline danger", type: "button", "data-key": "delete-identity", onclick: () => openDeleteDialog(d) }, "Delete identity\u2026")));
}

/** "Block identity": until a day, or until the owner lifts it. */
function openBlockDialog(d) {
  closeDialog();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const day = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const until = h("input", { class: "input", type: "date", id: "block-until", min: day(tomorrow), "aria-label": "Last day of the block" });
  const choice = value => h("input", { type: "radio", name: "block-end", value, checked: value === "date" });
  const byDate = choice("date"), open = choice("open");
  const error = h("p", { class: "field-error", hidden: true });
  const cancel = h("button", { class: "btn", type: "button", onclick: closeDialog }, "Cancel");
  const block = h("button", { class: "btn primary danger", type: "button" }, "Block");
  open.addEventListener("change", () => { until.disabled = open.checked; });
  byDate.addEventListener("change", () => { until.disabled = !byDate.checked; });
  block.addEventListener("click", async () => {
    let end = null;
    if (byDate.checked) {
      const r = parseBlockUntil(until.value);
      if (r.error) { error.textContent = r.error; error.hidden = false; until.focus(); return; }
      end = r.until;
    }
    block.disabled = cancel.disabled = true;
    try {
      await api.adminBlock(d.id, true, end);
    } catch (e) {
      error.textContent = e.message || "Could not block the identity.";
      error.hidden = false;
      block.disabled = cancel.disabled = false;
      return;
    }
    closeDialog();
    showSnackbar("Identity blocked.");
    await reloadIdentity(d.id);
  });
  showDialog(h("div", { class: "dialog adm-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "block-title" },
    h("h2", { class: "dialog-title", id: "block-title" }, "Block identity ", mono(shortId(d.id))),
    h("p", { class: "dialog-hint" }, "Its devices can't sync while it is blocked and show that the server's owner blocked it. Nothing is deleted; whoever shares notes with it keeps syncing."),
    h("div", { class: "adm-choices", role: "radiogroup", "aria-label": "How long" },
      h("label", { class: "adm-choice" }, byDate, h("span", {}, "Until"), until),
      h("label", { class: "adm-choice" }, open, h("span", {}, "Until I lift it"))),
    error,
    h("div", { class: "dialog-actions" }, cancel, block)),
  { focus: until, canClose: () => !cancel.disabled });
}

/** "Delete identity": typed confirmation, like a restore. */
function openDeleteDialog(d) {
  closeDialog();
  const input = h("input", { class: "input mono", id: "delete-confirm", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-describedby": "delete-warning" });
  const error = h("p", { class: "field-error", hidden: true });
  const cancel = h("button", { class: "btn", type: "button", onclick: closeDialog }, "Cancel");
  const remove = h("button", { class: "btn primary danger", type: "button", disabled: true }, "Delete");
  input.addEventListener("input", () => { remove.disabled = input.value.trim() !== "DELETE"; });
  input.addEventListener("keydown", e => { if (e.key === "Enter" && !remove.disabled) remove.click(); });
  remove.addEventListener("click", async () => {
    remove.disabled = cancel.disabled = input.disabled = true;
    try {
      await api.adminDeleteIdentity(d.id);
    } catch (e) {
      error.textContent = e.message || "Could not delete the identity.";
      error.hidden = false;
      cancel.disabled = input.disabled = false;
      remove.disabled = input.value.trim() !== "DELETE";
      return;
    }
    closeDialog();
    showSnackbar("Identity deleted.");
    S.open = null;
    loadAll();
  });
  showDialog(h("div", { class: "dialog adm-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "delete-title" },
    h("h2", { class: "dialog-title", id: "delete-title" }, "Delete identity ", mono(shortId(d.id))),
    h("p", { class: "adm-warning", id: "delete-warning" },
      "Deletes its notes, device list, contacts and invitations from the server. Notes it shares with others stay with them. Its devices stop syncing and keep the notes they have. This can't be undone."),
    h("label", { class: "field adm-confirm" }, h("span", { class: "field-label" }, "Type DELETE to confirm"), input),
    error,
    h("div", { class: "dialog-actions" }, cancel, remove)),
  { focus: input, canClose: () => !cancel.disabled });
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

/**
 * A group-size field (docs/requirements.md → "Server maintenance (admin)"): `override` the stored limit or null,
 * `fallback` what holds without it; `save(max)` stores it (null = reset), `done()` reloads what it changed.
 */
function membersForm({ id, override, fallback, hint, resetLabel, save: store, done }) {
  const input = h("input", {
    class: "input", type: "number", step: "1", min: "2", max: "50", inputmode: "numeric", id, "data-key": id,
    placeholder: String(fallback), value: override == null ? "" : String(override),
  });
  const error = h("p", { class: "field-error", hidden: true });
  const save = h("button", { class: "btn primary", type: "submit" }, "Save");
  const reset = override != null && h("button", { class: "btn outline", type: "button" }, resetLabel);

  async function apply(max) {
    save.disabled = true;
    if (reset) reset.disabled = true;
    try {
      await store(max);
      showSnackbar(max === null ? "Group size reset." : "Group size saved.");
      await done();
    } catch (e) {
      error.textContent = e.message || "Could not save the group size.";
      error.hidden = false;
      save.disabled = false;
      if (reset) reset.disabled = false;
    }
  }
  if (reset) reset.addEventListener("click", () => apply(null));
  return h("form", {
    class: "d-quota d-members", novalidate: true,
    onsubmit: e => {
      e.preventDefault();
      const r = parseMembersInput(input.value);
      error.hidden = !r.error;
      error.textContent = r.error || "";
      if (!r.error) apply(r.max);
    },
  },
  h("label", { class: "field-label", for: id }, "Max. people per group"),
  h("div", { class: "d-qrow" },
    h("div", { class: "adm-unit" }, input, h("span", {}, "people")),
    save, reset),
  h("p", { class: "field-hint" }, hint),
  error);
}

// ---------- news ----------

// The posts look like the app's note cards. Unlike a note, a post is not saved while it is typed (that would
// publish half-written text to everybody): the card being written has Cancel and Publish / Save.

async function reloadNews() {
  try {
    S.news = (await api.adminNews()).news;
    dropVanishedEdit();
  } catch (e) {
    showSnackbar(e.message || "Could not load the posts.");
  }
  render();
}

/** A post being edited that was deleted or archived meanwhile (another browser) can't be saved any more. */
function dropVanishedEdit() {
  const edit = S.newsEdit;
  if (!edit || edit.id === null || S.news.some(p => p.id === edit.id && !p.archived)) return;
  endNewsEdit();
  showSnackbar("The post was changed elsewhere. Your edit was discarded.");
}

/** Runs a change of the posts, says how it went and reloads the list. */
async function newsChange(run, done) {
  try {
    await run();
    showSnackbar(done);
  } catch (e) {
    showSnackbar(newsErrorText(e.status, e.body) || e.message || "Something went wrong.");
  }
  await reloadNews();
}

function startNewsEdit(post) {
  endNewsEdit();
  const initial = post ? post.body : NEW_POST_TEXT;
  const host = h("div", { class: "note-body md editor-host" });
  const error = h("p", { class: "field-error", role: "alert", hidden: true });
  const cancel = h("button", { class: "btn", type: "button", "data-key": "news-cancel", onclick: endNewsEditAndRender }, "Cancel");
  const submit = h("button", { class: "btn primary", type: "button", "data-key": "news-submit", onclick: submitNews }, post ? "Save" : "Publish");
  const el = h("article", { class: "note editing news-card", "data-key": "news-editing", "aria-label": post ? "Edit post" : "New post" },
    host, h("div", { class: "news-actions" }, error, cancel, submit));
  const edit = S.newsEdit = { id: post ? post.id : null, el, editor: null, text: initial, initial, error, submit };
  const syncSubmit = () => { submit.disabled = /^\s*(#+\s*)?$/.test(edit.text); };
  edit.editor = createEditor({
    parent: host, doc: initial,
    onChange: text => { edit.text = text; error.hidden = true; syncSubmit(); },
    // Escape leaves an untouched card; text that was typed stays (Cancel discards it on purpose).
    onEscape: () => { if (edit.text === edit.initial) endNewsEditAndRender(); },
  });
  syncSubmit();
  render();
  edit.editor.focusAt();   // the caret goes to the end: after "## " in a new post
  el.scrollIntoView({ block: "nearest" });
}

function endNewsEdit() {
  if (!S.newsEdit) return;
  S.newsEdit.editor.destroy();
  S.newsEdit = null;
}

function endNewsEditAndRender() {
  endNewsEdit();
  render();
}

async function submitNews() {
  const edit = S.newsEdit;
  if (!edit) return;
  const checked = checkNewsBody(edit.text);
  if (checked.error) {
    edit.error.textContent = checked.error;
    edit.error.hidden = false;
    return;
  }
  const buttons = edit.el.querySelectorAll(".news-actions .btn");
  buttons.forEach(b => { b.disabled = true; });
  const isNew = edit.id === null;
  try {
    if (isNew) await api.adminCreateNews(checked.body);
    else await api.adminUpdateNews(edit.id, { body: checked.body });
  } catch (e) {
    showSnackbar(newsErrorText(e.status, e.body) || e.message || "Something went wrong.");
    if (e.status === 404) { endNewsEdit(); await reloadNews(); return; }   // the post is gone: nothing to save into
    buttons.forEach(b => { b.disabled = false; });
    return;
  }
  endNewsEdit();
  showSnackbar(isNew ? "Post published" : "Post saved");
  await reloadNews();
}

function confirmDeletePost(post) {
  closeDialog();
  const cancel = h("button", { class: "btn", type: "button", onclick: closeDialog }, "Cancel");
  const remove = h("button", { class: "btn primary danger", type: "button" }, "Delete");
  remove.addEventListener("click", () => {
    closeDialog();
    newsChange(() => api.adminDeleteNews(post.id), "Post deleted");
  });
  showDialog(h("div", { class: "dialog adm-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "news-delete-title" },
    h("h2", { class: "dialog-title", id: "news-delete-title" }, "Delete this post?"),
    h("p", { class: "dialog-hint" }, "It disappears for everyone."),
    h("div", { class: "dialog-actions" }, cancel, remove)), { focus: cancel });
}

function postMenu(e, post) {
  const items = post.archived
    ? [{ label: "Publish again", onSelect: () => newsChange(() => api.adminUpdateNews(post.id, { archived: false }), "Post published") }]
    : [{ label: "Edit", onSelect: () => startNewsEdit(post) },
      { label: "Archive", onSelect: () => newsChange(() => api.adminUpdateNews(post.id, { archived: true }), "Post archived") }];
  openMenu(e.currentTarget, [...items, { label: "Delete", onSelect: () => confirmDeletePost(post) }]);
}

function postCard(post) {
  if (S.newsEdit && S.newsEdit.id === post.id) return S.newsEdit.el;
  const body = h("div", { class: "note-body md", html: renderMarkdown(post.body) });
  body.querySelectorAll("input.task").forEach(box => { box.disabled = true; });
  body.querySelectorAll(".ext-media").forEach(el => fillMedia(el, "never"));   // the owner's preview loads nothing
  return h("article", { class: "note news-card" + (post.archived ? " archived" : ""), "data-key": "post-" + post.id },
    body,
    h("div", { class: "note-meta" }, newsDateText(post, relativeTime)),
    h("button", {
      class: "icon-btn news-menu", type: "button", "data-key": "post-menu-" + post.id, "aria-haspopup": "menu",
      "aria-label": "Post actions", title: "Post actions", html: icon("more"), disabled: !!S.newsEdit, onclick: e => postMenu(e, post),
    }));
}

function newsSection() {
  const { published, archived } = splitNews(S.news);
  const writing = S.newsEdit && S.newsEdit.id === null;
  return h("section", { class: "adm-section", "aria-labelledby": "h-news" },
    h("div", { class: "adm-headrow" },
      h("h2", { class: "adm-h", id: "h-news" }, "News", h("span", { class: "count" }, String(published.length))),
      h("button", {
        class: "btn primary", type: "button", "data-key": "news-new", disabled: !!S.newsEdit, onclick: () => startNewsEdit(null),
      }, ico("plus"), "New post")),
    !S.news.length && !writing
      ? h("p", { class: "adm-empty" }, "No news yet. Posts you publish here appear for everyone using this server.")
      : h("div", { class: "news-list" },
        writing && S.newsEdit.el,
        published.map(postCard),
        !published.length && !writing && h("p", { class: "adm-muted" }, "No published posts.")),
    archived.length > 0 && h("h3", { class: "adm-subh", id: "h-archived" }, "Archived", h("span", { class: "count" }, String(archived.length))),
    archived.length > 0 && h("div", { class: "news-list" }, archived.map(postCard)));
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
  showDialog(h("div", { class: "dialog adm-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "restore-title" },
    h("h2", { class: "dialog-title", id: "restore-title" }, "Restore backup"),
    ...body,
    h("div", { class: "dialog-actions" }, cancel, result.error ? null : restore)),
  { focus: input || cancel, canClose: () => !cancel.disabled });
}

/**
 * Shows `dialog` on a scrim: Escape and a click beside it close it (while `canClose()`), Tab stays inside,
 * the focus starts on `focus` and goes back to the opener afterwards.
 */
function showDialog(dialog, { focus, canClose = () => true }) {
  const trigger = document.activeElement;
  const scrim = h("div", { class: "dialog-scrim", onclick: e => { if (e.target === scrim && canClose()) closeDialog(); } }, dialog);
  const onKey = e => {
    if (e.key === "Escape" && canClose()) { e.preventDefault(); closeDialog(); }
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
  focus.focus({ preventScroll: true });
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
      h("p", { class: "adm-text" }, "Add the ID to the repository secret ", h("code", {}, "ADMIN_IDENTITIES"), " and deploy the server (docs/operations.md)."));
  }
  return stateCard(
    h("h2", {}, S.error),
    h("button", { class: "btn primary", type: "button", onclick: start }, "Try again"));
}

// ---------- page ----------

function content() {
  const section = { overview: overviewSection, identities: identitiesSection, news: newsSection, backup: backupSection }[S.section]();
  if (S.tier === "desktop") return h("div", { class: "adm-wrap adm-shell" }, nav(), h("main", { class: "adm-main" }, section));
  return h("div", { class: "adm-wrap" }, h("main", { class: "adm-main" }, section));
}

function render() {
  const root = $("admin");
  S.tier = tierNow();
  const active = document.activeElement && root.contains(document.activeElement) ? document.activeElement : null;
  const focused = active ? active.dataset.key : null;
  const caret = active && active.type === "text" ? [active.selectionStart, active.selectionEnd] : null;
  // The post being written keeps its editor (and the text in it) across a redraw.
  const writing = S.newsEdit && active && S.newsEdit.el.contains(active);
  root.className = `admin tier-${S.tier}`;
  root.replaceChildren(header(), S.status === "ready" ? content() : statesView());
  if (writing) S.newsEdit.editor.view.focus();
  else if (focused) {
    const again = root.querySelector(`[data-key="${CSS.escape(focused)}"]`);
    again?.focus({ preventScroll: true });
    if (again && caret && again.type === "text") again.setSelectionRange(...caret);
  }
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
readJson("notedown.settings").then(s => { storedFlavor = (s && s.flavor) || ""; applyTheme(); });
systemDark.addEventListener("change", applyTheme);
initMenu();
$("restoreFile").addEventListener("change", e => { const f = e.target.files[0]; if (f) openRestoreDialog(f); });
for (const mq of [desktopMQ, tabletMQ]) mq.addEventListener("change", () => { if (S.status !== "loading") render(); });
start();

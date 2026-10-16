// The "Sync & sharing" panel (⋮ → "Sync & sharing…"): turning on sync with a
// recovery key, linking a device, devices and contacts. Phone: a full-screen
// sheet; tablet and desktop: a centered dialog. Pages stack inside the panel;
// the back button, Esc and the Android back key go one page back, then close.
// Real sync (sync/client.js) covers turning on, linking a device by QR code
// or with the recovery key, the device list and contacts (sync/contacts.js:
// invitations, requests); the sample (`state.sync.simulated`) simulates them,
// where "Simulate scan" stands in for the camera (docs/sync-and-sharing.md →
// "Identity and devices", "Contacts").
import { state, subscribe, setSync, replaceFiles, eraseStoredState, contacts } from "../store.js";
import { timestamp } from "../core/notes-file.js";
import { syncNow } from "../sync-sim.js";
import {
  syncNow as syncReal, turnOn, restore, removeDevice, signOut, eraseDevice, loadDevices, syncAvailable, startLinking, waitForLink, readLinkCode, linkDevice,
  deleteIdentity,
} from "../sync/client.js";
import { ApiError } from "../sync/api.js";
import { createInvitation, myCode, readInvite, sendRequest, removeContact, onContactConfirmed } from "../sync/contacts.js";
import { deviceRows, storageUsage, daysSince, STALE_DAYS, detachedFile } from "../core/sync-state.js";
import { loadSharingSample, loadSampleState } from "../sample.js";
import {
  generateRecoveryKey, normalizeRecoveryKey, inviteLink, initials, syncedAgo, contactId, uniqueName, nextColor,
} from "../core/sharing.js";
import { h, text, button, pushEntry, leaveEntry } from "./dom.js";
import { qrFigure, scannerView, cameraScanner } from "./qr.js";
import { showSnackbar } from "./snackbar.js";
import { icon } from "./icons.js";
import { requestAvatarHtml, requestHow } from "./people.js";

const $ = id => document.getElementById(id);
const real = () => !state.sync.simulated;
let stack = [];          // [{ page, data }]; the last entry is on screen
let isOpen = false;
let returnFocus = null;
let shownUsage = null, shownFull = false;   // `state.sync.usage` / `storageFull` the overview was drawn with
let shownContacts = "";  // the requests and contacts the overview was drawn with, as text
let pendingInvite = null; // an invitation link opened while sync was off: continued once sync is on
let leave = null;        // turns off what the page on screen started (camera)
let sampleIdentity = ""; // the sample's identity ID (sample/sharing.json), shown by "Your identity" in the sample

export function initSyncPanel() {
  $("syncBack").addEventListener("click", back);
  $("syncPanel").addEventListener("click", e => { if (e.target === $("syncPanel")) close(); });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && isOpen) { e.stopPropagation(); back(); }
  }, true);
  // Android back: the panel sits on one history entry; further pages go back inside it.
  window.addEventListener("popstate", () => {
    if (!isOpen) return;
    if (stack.length > 1) { stack.pop(); render(); pushEntry({ syncPanel: true }); }
    else close({ fromHistory: true });
  });
  subscribe(kind => {
    if (kind !== "sync" && kind !== "structure") return;
    if (kind === "sync") updateStatus();
    // The first round after opening brings the usage, a later one a contact request: show them without a reopen.
    if (isOpen && top().page === "overview" && (state.sync.usage !== shownUsage || state.sync.storageFull !== shownFull
        || contactsKey() !== shownContacts)) render({ keepScroll: true });
  });
  onContactConfirmed(contact => showSnackbar(`${contact.name} confirmed your request`));
  setInterval(updateStatus, 20000);
  loadSharingSample().then(sample => { sampleIdentity = sample.identity || ""; });   // warm the sample identity for the simulated scans
}

/** The sync icon and ⋮ → "Sync & sharing…": opening the panel also syncs. */
export function openSyncPanel() {
  openPanel(state.sync.enabled ? "overview" : "off");
  syncOnRequest();
}

/** Sync & sharing on "Link this device" (the card of a removed device, ui/sync-notice.js). */
export function openLinkPage() {
  openPanel("off");
  if (real() && !syncAvailable()) return;   // no sync server: the first page says so
  setStack([["off"], ["link", { seed: "link-" + Math.random() }]]);
}

/** A sync the user asked for (opening this panel, pull to refresh): shows
 *  "syncing" even when nothing changed; resolves once it is over. */
export function syncOnRequest() {
  if (!state.sync.enabled) return Promise.resolve();
  return real() ? syncReal({ show: true }) : syncNow();
}

/** Opens the panel's container on any page (the share dialog uses it too). */
export function openPanel(page, data = {}) {
  if (isOpen) return;
  isOpen = true;
  returnFocus = document.activeElement;
  stack = [{ page, data }];
  $("syncPanel").hidden = false;
  pushEntry({ syncPanel: true });
  render();
}

/** Pages other modules add to the container: { title, render(data), footer?(data) }. */
export function registerPage(name, def) {
  PAGES[name] = def;
}

const extraSections = [];   // what other modules add to the overview, after Storage: () → nodes or null

/** Adds a section to the overview (both modes), drawn by `fn()` each time; null leaves it out. */
export function addOverviewSection(fn) {
  extraSections.push(fn);
}

/** Replaces the page stack with [[page, data], …] (the last is shown). */
export function setStack(entries) {
  stack = entries.map(([page, data = {}]) => ({ page, data }));
  render();
}

export function closePanel() { close(); }

export const isPanelOpen = () => isOpen;

/** The page on screen while the panel is open. */
export const panelPage = () => isOpen ? top().page : null;

/** The data of the page on screen (`{}` while the panel is closed). */
export const panelData = () => isOpen ? top().data : {};

function close({ fromHistory = false } = {}) {
  if (!isOpen) return;
  isOpen = false;
  pendingInvite = null;
  leavePage();
  $("syncPanel").hidden = true;
  if (!fromHistory) leaveEntry("syncPanel");
  if (returnFocus && returnFocus.focus) returnFocus.focus();
}

function back() {
  if (stack.length > 1) { stack.pop(); render(); } else close();
}

/** One page back (none when only one is left). */
export function popPage() {
  if (stack.length > 1) { stack.pop(); render({ keepScroll: true }); }
}

/** Redraws the page on screen (e.g. after switching its tab). */
export function refreshPage(options) { render(options); }

/** Back to only `page`, e.g. the overview after a flow. */
export function resetPanel(page) { reset(page); }

/** What leaving the page on screen turns off (its camera). */
export function onLeave(fn) { leave = fn; }

export function go(page, data = {}) {
  stack.push({ page, data });
  render();
}

// Replaces the whole stack, e.g. back to the overview after a flow.
function reset(page) {
  stack = [{ page, data: {} }];
  render();
}

const top = () => stack[stack.length - 1];

// True while `data`'s page is the one on screen (polling stops otherwise).
const onScreen = data => isOpen && top().data === data;

function leavePage() {
  if (leave) leave();
  leave = null;
}

function render({ keepScroll = false } = {}) {
  const { page, data } = top();
  const def = PAGES[page];
  leavePage();
  $("syncTitle").textContent = typeof def.title === "function" ? def.title(data) : def.title;
  const nested = stack.length > 1;
  $("syncBack").innerHTML = icon(nested ? "back" : "close");
  $("syncBack").setAttribute("aria-label", nested ? "Back" : "Close");
  const scroll = $("syncBody").scrollTop;
  $("syncBody").replaceChildren(...def.render(data).filter(Boolean));
  $("syncBody").scrollTop = keepScroll ? scroll : 0;
  const footer = def.footer ? def.footer(data) : [];
  $("syncFoot").replaceChildren(...footer);
  $("syncFoot").hidden = footer.length === 0;
  $("syncTitle").focus({ preventScroll: true });
  const auto = $("syncBody").querySelector("[data-autofocus]");
  if (auto && matchMedia("(pointer: fine)").matches) auto.focus();
  updateStatus();
}

// ---------- small DOM helpers ----------

export const section = title => h("h3", { class: "sheet-section" }, title);

function field(label, input, hint) {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), input, hint && h("span", { class: "field-hint" }, hint));
}

function textInput(props, onInput, onEnter) {
  return h("input", {
    type: "text", class: "input", autocomplete: "off", autocapitalize: "words", spellcheck: "false",
    "data-autofocus": true, ...props,
    oninput: e => onInput(e.target.value),
    onkeydown: e => { if (e.key === "Enter" && onEnter) onEnter(); },
  });
}

function segmented(options, current, onPick) {
  return h("div", { class: "segmented", role: "tablist" }, options.map(([id, label]) =>
    h("button", { class: "segment", role: "tab", type: "button", "aria-selected": String(id === current), onclick: () => onPick(id) }, label)));
}

/** `href` makes the row a link (`newTab`: opens in a new tab); without `open` or `href` it is plain text. */
export function row({ icon: ic, avatar, title, sub, remove, open, href, newTab, unverified }) {
  const lead = [
    avatar ? h("span", { class: "avatar", "aria-hidden": "true" }, avatar) : h("span", { class: "row-icon", html: icon(ic) }),
    h("span", { class: "row-text" }, h("span", { class: "row-title" }, title), sub && h("span", { class: "row-sub" + (unverified ? " unverified-sub" : "") }, sub)),
  ];
  return h("li", { class: "sheet-row" },
    href ? h("a", { class: "row-open", href, target: newTab ? "_blank" : null, rel: newTab ? "noopener" : null }, lead)
      : open ? h("button", { class: "row-open", type: "button", onclick: open }, lead) : lead,
    remove && h("button", { class: "icon-btn", type: "button", "aria-label": `Remove ${title}`, html: icon("close"), onclick: remove }));
}

async function copyText(value) {
  try { await navigator.clipboard.writeText(value); return true; } catch { /* fall back below */ }
  const area = h("textarea", { class: "visually-hidden", readonly: true });
  area.value = value;
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { /* not allowed */ }
  area.remove();
  return ok;
}

function download(name, content) {
  const a = h("a", { href: URL.createObjectURL(new Blob([content], { type: "text/plain" })), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}

// A button that runs a real sync action: busy while it runs, its error shown below.
export function action(label, run, cls = "primary") {
  const error = h("p", { class: "field-error", role: "alert", hidden: true });
  const btn = button(label, cls, async () => {
    btn.disabled = true;
    btn.textContent = label + "…";
    error.hidden = true;
    try {
      await run();
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
      btn.disabled = false;
      btn.textContent = label;
    }
  });
  return { btn, error };
}

// After an erase the page restarts at the first start. `?sample` / `?sync=off`
// would load the sample again, so they are dropped from the address.
function restart() {
  const url = new URL(location.href);
  url.searchParams.delete("sample");
  url.searchParams.delete("sync");
  if (url.href === location.href) location.reload();
  else location.replace(url);
}

// Another device's row: when it last synced; after STALE_DAYS a warning that suggests removing it
// (docs/requirements.md → "Sync and sharing"). → { sub, stale }
function lastSynced(synced) {
  const days = daysSince(synced);
  if (days === undefined) return { sub: "No sync reported yet", stale: false };
  if (days >= STALE_DAYS) return { sub: `No sync for ${days} days — remove it if you don't use it any more`, stale: true };
  return { sub: "Last synced " + (days < 1 ? "today" : days < 2 ? "yesterday" : `${days} days ago`), stale: false };
}

const deviceRow = (title, synced, remove) => {
  const { sub, stale } = lastSynced(synced);
  return row({ icon: "device", title, sub, unverified: stale, remove });
};

function deviceName() {
  if (matchMedia("(min-width: 1024px)").matches) return "This browser";
  return matchMedia("(min-width: 600px)").matches ? "This tablet" : "This phone";
}

// ---------- status line ----------

export function statusText() {
  const { status, lastSync } = state.sync;
  if (status === "syncing") return "Syncing…";
  if (status === "offline") return "Offline — changes sync when you're back online";
  if (status === "error") return state.sync.error || "Sync failed";
  return lastSync ? `Synced · ${syncedAgo(lastSync)}` : "Synced";
}

// At the bottom of the overview: what sync is doing, or when it last ran.
function statusLine() {
  return h("div", { class: "sync-status", "data-sync-status": "", "data-status": state.sync.status },
    h("span", { class: "sync-dot", "aria-hidden": "true" }),
    h("span", { class: "sync-status-text", role: "status" }, statusText()));
}

function updateStatus() {
  const el = isOpen && $("syncFoot").querySelector("[data-sync-status]");
  if (!el) return;
  el.dataset.status = state.sync.status;
  el.querySelector(".sync-status-text").textContent = statusText();
}

// ---------- flows ----------

// Takes over the sample identity and its notes, as a linked or restored device would.
async function adoptIdentity(recoveryKey, message) {
  const next = await loadSampleState({ sync: true });
  if (recoveryKey) next.sync.recoveryKey = recoveryKey;
  replaceFiles(next);
  syncNow();
  if (isOpen) reset("overview");
  showSnackbar(message);
}

function removeFromList(key, index, label) {
  const list = state.sync[key];
  const item = list[index];
  setSync({ [key]: list.filter((_, i) => i !== index) });
  render({ keepScroll: true });
  showSnackbar(`${label} removed`, () => {
    const restored = [...state.sync[key]];
    restored.splice(index, 0, item);
    setSync({ [key]: restored });
    if (isOpen && top().page === "overview") render({ keepScroll: true });
  });
}

/** Adds a contact (the sample); `pending` while the other side hasn't confirmed this user's request;
 *  verified when `via` is "scan" (in person), not when "link" (backlog #4). */
export function addContact(name, via, { pending = false } = {}) {
  const id = contactId(name, state.sync.contacts.map(c => c.id));
  const contact = { id, name, color: nextColor(state.sync.contacts), ...(pending && { pending: true }), ...(via === "scan" && { verified: timestamp() }) };
  setSync({ contacts: [...state.sync.contacts, contact] });
  contactAdded(contact);
  if (!pending) return;
  // The sample: the other side confirms a moment later, as a later sync round would bring it.
  setTimeout(() => {
    if (!state.sync.contacts.some(c => c.id === id && c.pending)) return;
    setSync({ contacts: state.sync.contacts.map(c => { if (c.id !== id) return c; const { pending: _, ...confirmed } = c; return confirmed; }) });
    if (isOpen && top().page === "overview") render({ keepScroll: true });
    showSnackbar(`${name} confirmed your request`);
  }, 4000);
}

/** What the panel shows once a contact is in the list (both modes): back to the share dialog that asked
 *  for it, else the overview; "Request sent to …" while the contact is pending, else "… added". */
export function contactAdded(contact) {
  // Opened from the share dialog: go back to it with the new contact listed.
  const asker = stack.findLastIndex(e => e.data.onContactAdded);
  if (asker >= 0) {
    stack.length = asker + 1;
    stack[asker].data.onContactAdded(contact);
    render({ keepScroll: true });
  } else if (isOpen) reset("overview");
  showSnackbar(contact.pending ? `Request sent to ${contact.name}` : `${contact.name} added`);
}

// A scanned code of an existing contact: verified now, or already.
function scannedContact(c) {
  reset("overview");
  if (c.verified) return showSnackbar(`${c.name} is already verified`);
  import("./verify-contact.js").then(m => m.markVerified(c.id));
}

// A link opened in the app, from a tap on it, the Android App Link or the web page it forwards from.
// Contacts need sync: without it the panel explains that first and continues once sync is on.
export function openInvite(text) {
  if (state.sync.simulated) return;
  const found = readInvite(text);
  if (!found) return showSnackbar("That's not a valid invitation link");
  const invite = { text, name: found.name };
  if (!state.sync.enabled) {
    if (isOpen) closePanel();
    pendingInvite = invite;
    return openPanel("inviteOff", invite);
  }
  if (isOpen) return setStack([["overview"], ["nameContact", invite]]);
  openPanel("overview");
  go("nameContact", invite);
  syncOnRequest();
}

// Sync was just turned on or this device linked: back to the overview, then on with an opened invitation.
function enteredSync(message) {
  reset("overview");
  showSnackbar(message);
  if (!pendingInvite) return;
  const invite = pendingInvite;
  pendingInvite = null;
  go("nameContact", invite);
}

// The new device's QR code (real sync): a fresh relay slot, polled until a
// linked device has answered; a new code once it has expired.
function linkCodeView(data) {
  data.view = linkCodeContent(data);
  return data.view;
}

// Only the code is swapped when the slot arrives or fails, so a recovery key
// being typed below it stays.
const refreshLinkCode = data => { if (onScreen(data)) data.view.replaceWith(linkCodeView(data)); };

function linkCodeContent(data) {
  const box = h("div", { class: "qr-wait" });
  if (data.failed) {
    box.append(text(data.failed, "sheet-text muted center"), button("New code", "outline", () => {
      data.failed = null;
      refreshLinkCode(data);
    }));
    return box;
  }
  if (!data.link) {
    data.link = startLinking();
    data.link.then(link => {
      data.link = link;
      refreshLinkCode(data);
      return waitForLink(link, () => !onScreen(data));
    }).then(linked => {
      if (!linked) return;
      if (isOpen) enteredSync("Device linked");
      else showSnackbar("Device linked");
    }).catch(e => {
      data.link = null;
      data.failed = e instanceof ApiError && e.status === 404 ? "This code has expired." : `Couldn't link: ${e.message}`;
      refreshLinkCode(data);
    });
  }
  if (data.link instanceof Promise) return h("div", { class: "qr-wait" }, text("Preparing the code…", "sheet-text muted center"));
  return qrFigure(data.link.code, "QR code of this device");
}

// ---------- pages ----------

/** The address of one of the app's static pages ("privacy", "terms"), relative to the app root. */
export const legalUrl = page => new URL(`../../${page}/`, import.meta.url).href;

/** "By turning on sync you accept …": under the buttons that turn sync on (no checkbox). */
function legalLine() {
  return h("p", { class: "sheet-text muted legal-line" }, "By turning on sync you accept the ",
    h("a", { href: legalUrl("terms") }, "Terms of use"), " and the ", h("a", { href: legalUrl("privacy") }, "Privacy policy"), ".");
}

const PAGES = {
  off: {
    title: "Sync & sharing",
    render: () => [
      h("div", { class: "hero", html: icon("sync") }),
      state.sync.ended === "deleted" && text("Your sync data was deleted from the server. Your notes stay on this device, all of them private now.", "sheet-notice"),
      state.sync.ended === "removed" && text("This device was removed from your devices. Its notes stay here, all of them private now; link it again to sync.", "sheet-notice"),
      text("Keep your notes in step on all your devices and share single notes with others. End-to-end encrypted — no account, no email."),
      real() && !syncAvailable()
        ? text("This copy of the app has no sync server.", "sheet-text muted")
        : h("div", { class: "sheet-actions" },
          button("Turn on sync", "primary", () => go("name")),
          button("Link to an existing device", "", () => go("link", { seed: "link-" + Math.random() }))),
      !(real() && !syncAvailable()) && legalLine(),
    ],
  },

  name: {
    title: "Your name",
    render: data => {
      const next = button("Continue", "primary", () => go("key", { name: data.name.trim(), key: generateRecoveryKey() }));
      data.name ||= "";
      next.disabled = !data.name.trim();
      const input = textInput({ value: data.name, maxlength: "40", "aria-label": "Your name" },
        v => { data.name = v; next.disabled = !v.trim(); }, () => { if (!next.disabled) next.click(); });
      return [
        field("Your name", input, "Shown to your contacts. Stays on your devices."),
        h("div", { class: "sheet-actions" }, next),
      ];
    },
  },

  key: {
    title: "Your recovery key",
    render: data => {
      const saved = h("input", { type: "checkbox", id: "keySaved" });
      const { btn: done, error } = action("Done", async () => {
        if (real()) await turnOn(data.name, data.key);
        else {
          setSync({ enabled: true, name: data.name, recoveryKey: data.key, devices: [], contacts: [] });
          syncNow();
        }
        enteredSync("Sync is on");
      });
      done.disabled = true;
      saved.addEventListener("change", () => { done.disabled = !saved.checked; });
      return [
        text("The only way back to your notes if you lose all your devices. Store it somewhere safe — it's shown only once."),
        h("div", { class: "key-box", role: "group", "aria-label": "Recovery key " + data.key.replaceAll("-", " ") },
          data.key.split("-").map(g => h("span", { class: "key-group" }, g))),
        h("div", { class: "button-row" },
          h("button", {
            class: "btn outline", type: "button",
            onclick: async () => showSnackbar(await copyText(data.key) ? "Recovery key copied" : "Copying is blocked here"),
          }, h("span", { html: icon("copy") }), "Copy"),
          h("button", {
            class: "btn outline", type: "button",
            onclick: () => download("notedown-recovery-key.txt", `NoteDown recovery key\n\n${data.key}\n\nKeep it somewhere safe. It is the only way back to your notes if you lose all your devices.\n`),
          }, h("span", { html: icon("download") }), "Download")),
        h("label", { class: "check-row" }, saved, h("span", {}, "I've stored it somewhere safe")),
        h("div", { class: "sheet-actions" }, done),
        error,
      ];
    },
  },

  link: {
    title: "Link this device",
    render: data => {
      const error = h("p", { class: "field-error", role: "alert", hidden: true });
      const input = h("input", {
        type: "text", class: "input mono", autocomplete: "off", autocapitalize: "characters", spellcheck: "false",
        placeholder: "ABCD-EFGH-…", "aria-label": "Recovery key",
      });
      const { btn: submit, error: failed } = action("Restore", async () => {
        const key = normalizeRecoveryKey(input.value);
        error.hidden = !!key;
        if (!key) { error.textContent = "That doesn't look like a recovery key. It has 26 letters and digits."; input.focus(); return; }
        if (!real()) return adoptIdentity(key, "Notes restored");
        await restore(key);
        enteredSync("Device linked");
      });
      input.addEventListener("keydown", e => { if (e.key === "Enter") submit.click(); });
      return [
        h("div", { class: "qr-wrap" }, real() ? linkCodeView(data) : qrFigure(data.seed, "QR code of this device")),
        text("On a device that already syncs, open Sync & sharing → Link a device and scan this code."),
        !real() && button("Simulate scan (prototype)", "", () => adoptIdentity(null, "Device linked")),
        h("div", { class: "sheet-divider" }),
        field("Or enter your recovery key", input),
        error,
        h("div", { class: "sheet-actions" }, submit),
        failed,
      ];
    },
  },

  overview: {
    title: "Sync & sharing",
    render: data => real() ? realOverview(data) : simulatedOverview(),
    footer: () => [statusLine()],
  },

  confirmLink: {
    title: "Link a device",
    render: data => {
      const { btn, error } = action("Link", async () => {
        if (real()) await linkDevice(data.code);
        else setSync({ devices: [...state.sync.devices, { name: data.name, synced: timestamp() }] });
        reset("overview");
        showSnackbar("Device linked");
      });
      return [
        h("div", { class: "hero", html: icon("device") }),
        h("p", { class: "qr-name" }, data.name || "New device"),
        text("Link this device to your notes? It can then read and change all of them. Only link devices you own.", "sheet-text center"),
        h("div", { class: "sheet-actions" }, btn, button("Cancel", "", back)),
        error,
      ];
    },
  },

  removeDevice: {
    title: "Remove device",
    render: data => {
      const { btn, error } = action("Remove", async () => {
        await removeDevice(data.id);
        reset("overview");
        showSnackbar(`${data.label} removed`);
      });
      return [
        text(`${data.label} can't sync any more and can't read notes changed from now on. What it already has stays on it.`),
        h("div", { class: "sheet-actions" }, btn),
        error,
      ];
    },
  },

  identity: {
    title: "Your identity",
    render: () => {
      const id = identityId();
      return [
        text("Your anonymous ID on this sync server. The server's owner needs it to switch on extra features for you."),
        h("div", { class: "id-box", role: "group", "aria-label": "Your identity ID" }, id),
        h("div", { class: "button-row" },
          h("button", {
            class: "btn outline", type: "button",
            onclick: async () => showSnackbar(await copyText(id) ? "ID copied" : "Copying is blocked here"),
          }, h("span", { html: icon("copy") }), "Copy ID")),
      ];
    },
  },

  deleteIdentity: {
    title: "Delete sync data",
    render: () => {
      const input = h("input", {
        type: "text", class: "input mono", autocomplete: "off", autocapitalize: "characters", spellcheck: "false",
        placeholder: "ABCD-EFGH-…", "aria-label": "Recovery key",
      });
      const { btn, error: failed } = action("Delete for good", async () => {
        const key = normalizeRecoveryKey(input.value);
        if (!key) { input.focus(); throw new Error("That doesn't look like a recovery key. It has 26 letters and digits."); }
        if (real()) await deleteIdentity(key);
        else replaceFiles({ file: detachedFile(state.file, state.shared, "me"), shared: [], sync: { ended: "deleted" } });
        reset("off");
        showSnackbar("Sync data deleted");
      }, "primary danger");
      input.addEventListener("keydown", e => { if (e.key === "Enter") btn.click(); });
      return [
        text("Everything the sync server keeps for you is deleted: your notes, your device list and your contacts. Notes you share with others stay with them."),
        text("All your devices stop syncing. Each keeps the notes it has, all of them private then. This can't be undone.", "sheet-text"),
        field("Enter your recovery key to confirm", input),
        h("div", { class: "sheet-actions" }, btn, button("Cancel", "", back)),
        failed,
      ];
    },
  },

  signOut: {
    title: "Sign out this device",
    render: data => {
      // Signing out can fail (offline, server): then erasing alone is offered.
      const forced = action("Erase without signing out", async () => {
        await eraseDevice();
        restart();
      }, "outline danger");
      const fallback = h("div", { class: "sheet-actions", hidden: true },
        text("Changes not synced yet are lost, and this device stays on your device list until you remove it from another device."),
        forced.btn, forced.error);
      const { btn, error } = action("Sign out and erase", async () => {
        if (real()) {
          try { await signOut(); } catch (e) { fallback.hidden = false; throw e; }
        } else eraseStoredState();
        restart();
      }, "primary danger");
      const rest = data.others === false
        ? " Your notes stay on the server, encrypted; you get them back on any device with your recovery key."
        : data.others ? " Your notes stay on your other devices." : "";
      return [
        text("This device is taken off your device list, and all notes, settings and keys NoteDown keeps on it are erased." + rest),
        h("div", { class: "sheet-actions" }, btn, button("Cancel", "", back)),
        error,
        fallback,
      ];
    },
  },
};

// The "Your identity" section, last on the overview: a row that opens the page with the full ID.
const identityId = () => (real() ? state.sync.identity : sampleIdentity);

function identitySection() {
  const id = identityId();
  if (!id) return null;
  return [
    section("Your identity"),
    h("ul", { class: "sheet-card" }, row({ icon: "user", title: "Identity ID", sub: id.slice(0, 8) + "…", open: () => go("identity") })),
    h("div", { class: "button-row" }, button("Delete sync data", "outline danger", () => go("deleteIdentity"))),
  ];
}

// The Storage section: used share of the server quota, hidden while unknown.
function storageSection() {
  const { usage } = state.sync;
  shownUsage = usage;
  shownFull = state.sync.storageFull;
  if (!usage) return null;
  const u = storageUsage(usage, shownFull);
  return [
    section("Storage"),
    h("div", {
      class: "storage-bar", role: "progressbar", "aria-label": "Sync storage used", "data-level": u.level,
      "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(u.percent), "aria-valuetext": u.text,
    }, h("div", { class: "storage-fill", style: `width: ${u.percent}%` })),
    text(u.text, "sheet-text storage-text"),
    u.level === "full" && text("Sync storage is full. Delete notes you no longer need (archived ones count too) to sync again.", "field-error"),
  ];
}

// The requests waiting for a decision and the contacts, with the buttons to add one (both modes).
// `removeRow(contact, index)` is what a row's remove button does.
function contactsSections(removeRow) {
  const { requests } = state.sync;
  const list = contacts();
  shownContacts = contactsKey();
  return [
    requests.length > 0 && [
      section("Contact requests"),
      h("ul", { class: "sheet-card" }, requests.map(r => h("li", { class: "sheet-row" },
        h("span", { html: requestAvatarHtml(r) }).firstChild,
        h("span", { class: "row-text" }, h("span", { class: "row-title" }, r.name), h("span", { class: "row-sub" }, requestHow(r))),
        button("Review", "outline", () => go("contactRequest", { request: r }))))),
    ],
    section("Contacts"),
    list.length
      ? h("ul", { class: "sheet-card" }, list.map((c, i) =>
          row({
            avatar: initials(c.name), title: c.name, remove: () => removeRow(c, i),
            sub: gone(c.id) ? "Deleted their sync data" : c.pending ? "Waiting for confirmation" : c.verified ? null : "Not verified",
            unverified: !gone(c.id) && !c.pending && !c.verified,
            open: !c.pending && (() => go("verifyContact", { id: c.id, tab: "code" })),
          })))
      : text("No contacts yet. Add one to share notes with them.", "sheet-text muted"),
    h("div", { class: "button-row" },
      button("Add contact", "outline", () => go("addContact", { mode: "scan" })),
      button("My code", "outline", () => go("myCode"))),
  ].flat();
}

// A contact whose identity was deleted from the server (backlog #34).
const gone = id => state.sync.deleted.includes(id);

// What the overview was drawn from, to redraw it when a round changes the requests or contacts.
const contactsKey = () => JSON.stringify([state.sync.requests, contacts(), state.sync.deleted]);

// Real sync: this identity's devices, loaded from the server, and the contacts.
function realOverview(data) {
  if (!data.rows && !data.loading) {
    data.loading = true;
    loadDevices()
      .then(devices => { data.rows = deviceRows(devices, state.sync.device, state.file.devices); })
      .catch(e => { data.failed = e.message; })
      .finally(() => { data.loading = false; if (isOpen && top().data === data) render({ keepScroll: true }); });
  }
  return [
    section("Devices"),
    data.rows
      ? h("ul", { class: "sheet-card" }, data.rows.map(d => d.own
          ? row({ icon: "device", title: d.label, sub: d.named ? "This device" : deviceName() })
          : deviceRow(d.label, d.synced, () => go("removeDevice", d))))
      : text(data.failed ? `Couldn't load the devices: ${data.failed}` : "Loading…", "sheet-text muted"),
    h("div", { class: "button-row" }, button("Link a device", "outline", () => go("linkDevice"))),
    h("div", { class: "button-row" }, button("Sign out this device", "outline danger",
      () => go("signOut", { others: data.rows ? data.rows.length > 1 : null }))),
    contactsSections(c => go("removeContact", { id: c.id, name: c.name })),
    storageSection(),
    ...extraSections.map(fn => fn()),
    identitySection(),
  ].flat();
}

// A simulated device: { name, synced } (a plain name in sync states stored before the sync times).
const simDevice = d => (typeof d === "string" ? { name: d } : d);

// The sample: simulated devices and contacts.
function simulatedOverview() {
  const { devices } = state.sync;
  return [
    section("Devices"),
    h("ul", { class: "sheet-card" },
      row({ icon: "device", title: "This device", sub: deviceName() }),
      devices.map(simDevice).map((d, i) => deviceRow(d.name, d.synced, () => removeFromList("devices", i, d.name)))),
    h("div", { class: "button-row" }, button("Link a device", "outline", () => go("linkDevice"))),
    h("div", { class: "button-row" }, button("Sign out this device", "outline danger", () => go("signOut", { others: devices.length > 0 }))),
    contactsSections((c, i) => removeFromList("contacts", i, c.name)),
    storageSection(),
    ...extraSections.map(fn => fn()),
    identitySection(),
  ].flat();
}

// Linking a device from this one (both modes) and the pages only the sample reaches: contacts.
Object.assign(PAGES, {
  linkDevice: {
    title: "Link a device",
    render: () => {
      const hint = "Scan the code shown on the new device.";
      if (!real()) {
        return [
          scannerView(hint),
          h("div", { class: "button-row center" }, button("Simulate scan (prototype)", "", () =>
            go("confirmLink", { name: uniqueName("New device", state.sync.devices.map(d => simDevice(d).name)) }))),
        ];
      }
      const scanner = cameraScanner({
        hint,
        wrongCode: "That's not the code of a new NoteDown device.",
        noCamera: "No camera found on this device.",
        onCode: code => {
          const found = readLinkCode(code);
          if (found) go("confirmLink", { code, name: found.name });
          return Boolean(found);
        },
      });
      leave = scanner.stop;
      return [
        scanner.el,
        text("No camera? Enter your recovery key on the new device instead.", "sheet-text muted center"),
      ];
    },
  },

  addContact: {
    title: "Add contact",
    render: data => {
      const tabs = segmented([["scan", "Scan code"], ["link", "Invite by link"]], data.mode, mode => { data.mode = mode; render(); });
      if (data.mode === "link") return [tabs, ...(real() ? realInviteLink(data) : simulatedInviteLink(data))];
      if (!real()) {
        return [
          tabs,
          scannerView("Scan the code on your contact's phone."),
          h("div", { class: "button-row center" }, button("Simulate scan (prototype)", "", async () => {
            const sample = await loadSharingSample();
            go("nameContact", { name: sample.scanSuggestion, via: "scan" });
          })),
          pasteLink(),
        ];
      }
      const scanner = cameraScanner({
        hint: "Scan the code on your contact's phone.",
        wrongCode: "That's not a NoteDown invitation.",
        noCamera: "No camera found on this device.",
        onCode: text => {
          const found = readInvite(text);
          // The code of someone already a contact verifies them instead of asking again (backlog #4).
          if (found?.contact && !found.contact.pending) scannedContact(found.contact);
          else if (found) go("nameContact", { text, name: found.name, via: "scan" });
          return Boolean(found);
        },
      });
      leave = scanner.stop;
      return [tabs, scanner.el, pasteLink()];
    },
  },

  nameContact: {
    title: "Name the contact",
    render: data => {
      data.suggested ??= Boolean(data.name);
      data.name ||= "";
      const input = textInput({ value: data.name, maxlength: "40", "aria-label": "Contact name" },
        v => { data.name = v; send.btn.disabled = !v.trim(); }, () => { if (!send.btn.disabled) send.btn.click(); });
      const send = action("Send request", async () => {
        if (!real()) return addContact(data.name.trim(), data.via, { pending: true });
        contactAdded(await sendRequest(data.text, data.name.trim(), { verified: data.via === "scan" }));
      });
      send.btn.disabled = !data.name.trim();
      return [
        field("Name", input, data.suggested ? "Only you see this name. Your contact suggested it." : "Only you see this name."),
        text("Your contact confirms the request on their device.", "sheet-text muted"),
        h("div", { class: "sheet-actions" }, send.btn),
        send.error,
      ];
    },
  },

  myCode: {
    title: "My code",
    render: data => {
      if (!real()) {
        return [
          h("div", { class: "qr-wrap" }, qrFigure("me:" + state.sync.name + state.sync.recoveryKey, "Your contact code")),
          h("p", { class: "qr-name" }, state.sync.name),
          text("Let a contact scan this code to connect. You confirm their request here.", "sheet-text center"),
          h("div", { class: "button-row center" }, button("Simulate request (prototype)", "", () => import("./contact-requests.js").then(m => m.simulateRequest()))),
        ];
      }
      // The code is an invitation, open for 10 minutes: a new one replaces it before it runs out.
      if (!data.invite && !data.failed && !data.loading) {
        data.loading = true;
        myCode().then(invite => { data.invite = invite; }, e => { data.failed = e.message; })
          .finally(() => { data.loading = false; if (onScreen(data)) render(); });
      }
      if (data.invite) {
        const timer = setTimeout(() => { data.invite = null; if (onScreen(data)) render(); }, Math.max(data.invite.expires - Date.now() - 30000, 1000));
        leave = () => clearTimeout(timer);
      }
      return [
        data.invite
          ? h("div", { class: "qr-wrap" }, qrFigure(data.invite.text, "Your contact code"))
          : data.failed
            ? h("div", { class: "qr-wait" }, text(data.failed, "field-error"), button("Try again", "outline", () => { data.failed = null; render(); }))
            : h("div", { class: "qr-wait" }, text("Preparing the code…", "sheet-text muted center")),
        h("p", { class: "qr-name" }, state.sync.name),
        text("Let a contact scan this code to connect. You confirm their request here. The code works once, for 10 minutes.", "sheet-text center"),
      ];
    },
  },

  removeContact: {
    title: "Remove contact",
    render: data => {
      const { btn, error } = action("Remove", async () => {
        await removeContact(data.id);
        reset("overview");
        showSnackbar(`${data.name} removed`);
      });
      return [
        text(`${data.name} is removed from your contacts. To connect again, one of you sends a new request.`),
        h("div", { class: "sheet-actions" }, btn),
        error,
      ];
    },
  },

  inviteOff: {
    title: "Add contact",
    render: data => [
      h("div", { class: "hero", html: icon("sync") }),
      text(`${data.name || "Someone"} invited you to be a contact. ` + (syncAvailable()
        ? "Contacts need sync. Turn it on, then you can send your request."
        : "Contacts need sync, but this copy of the app has no sync server."), "sheet-text center"),
    ],
    footer: () => [
      h("div", { class: "foot-actions" },
        button("Cancel", "", () => closePanel()),
        syncAvailable() && button("Turn on sync", "primary", () => setStack([["off"], ["name"]]))),
    ],
  },
});

// "Invite by link" in the sample: a made-up link.
function simulatedInviteLink(data) {
  data.link ||= inviteLink();
  const linkField = readonlyField(data.link);
  return [inviteLinkText(), linkField, h("div", { class: "sheet-actions" }, button("Copy link", "primary", () => shareLink(data.link, linkField)))];
}

// "Invite by link": a link invitation (open 7 days, one request) made the first time the tab shows.
function realInviteLink(data) {
  if (!data.invite && !data.failed) {
    data.invite = createInvitation("link");
    data.invite.then(invite => { data.invite = invite; }, e => { data.invite = null; data.failed = e.message; })
      .finally(() => { if (onScreen(data)) render(); });
  }
  if (data.failed) {
    return [text(data.failed, "field-error"), h("div", { class: "button-row" }, button("Try again", "outline", () => { data.failed = null; render(); }))];
  }
  if (data.invite instanceof Promise) return [inviteLinkText(), h("div", { class: "qr-wait" }, text("Preparing the link…", "sheet-text muted center"))];
  const linkField = readonlyField(data.invite.text);
  return [inviteLinkText(), linkField, h("div", { class: "sheet-actions" }, button("Copy link", "primary", () => shareLink(data.invite.text, linkField)))];
}

function readonlyField(value) {
  const input = h("input", { class: "input mono", type: "text", readonly: true, value, "aria-label": "Invitation link" });
  input.addEventListener("focus", () => input.select());
  return input;
}

const inviteLinkText = () => text("Send this link through any messenger. Whoever opens it can ask to become your contact; you confirm the request. The link works once, for 7 days.");

// The system's share sheet on touch devices, else the clipboard.
async function shareLink(link, field) {
  if (navigator.share && matchMedia("(pointer: coarse)").matches) {
    try { await navigator.share({ url: link }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  if (await copyText(link)) showSnackbar("Link copied");
  else { field.focus(); showSnackbar("Select the link and copy it"); }
}

// "Paste link" under the camera: for a link that came in a message, where the app can't open it by itself.
function pasteLink() {
  const error = h("p", { class: "field-error", role: "alert", hidden: true });
  const input = h("input", {
    type: "text", class: "input mono", autocomplete: "off", autocapitalize: "off", spellcheck: "false",
    placeholder: "https://…/invite/#…", "aria-label": "Paste link",
    oninput: () => { error.hidden = true; },
  });
  const submit = async () => {
    let value = input.value.trim();
    if (!value) {   // nothing typed: take what is on the clipboard, where the browser allows reading it
      try { value = (await navigator.clipboard.readText()).trim(); input.value = value; } catch { /* needs the user to paste */ }
    }
    const found = value && (real() ? readInvite(value) : /^https?:\/\/\S+$/.test(value) && {});
    error.hidden = Boolean(found);
    if (!found) {
      error.textContent = value ? "That's not a NoteDown invitation link." : "Paste the link into the field first.";
      input.focus();
    } else if (real()) go("nameContact", { text: value, name: found.name });
    else go("nameContact", { name: (await loadSharingSample()).scanSuggestion, via: "link" });
  };
  input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
  return h("div", { class: "paste-link" },
    h("div", { class: "sheet-divider" }),
    field("Or paste a link", input, "A link you got in a message."),
    error,
    h("div", { class: "button-row" }, button("Paste link", "outline", submit)));
}

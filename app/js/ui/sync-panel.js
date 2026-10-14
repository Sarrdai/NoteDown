// The "Sync & sharing" panel (⋮ → "Sync & sharing…"): turning on sync with a
// recovery key, linking a device, devices and contacts. Phone: a full-screen
// sheet; tablet and desktop: a centered dialog. Pages stack inside the panel;
// the back button, Esc and the Android back key go one page back, then close.
// Real sync (sync/client.js) covers turning on, linking a device by QR code
// or with the recovery key and the device list; contacts come later and are
// only simulated for the sample (`state.sync.simulated`), where "Simulate
// scan" stands in for the camera (docs/sync-and-sharing.md → "Identity and
// devices", "Contacts").
import { state, subscribe, setSync, replaceFiles, eraseStoredState } from "../store.js";
import { syncNow } from "../sync-sim.js";
import {
  syncNow as syncReal, turnOn, restore, removeDevice, signOut, eraseDevice, loadDevices, syncAvailable, startLinking, waitForLink, readLinkCode, linkDevice,
} from "../sync/client.js";
import { ApiError } from "../sync/api.js";
import { deviceRows, storageUsage } from "../core/sync-state.js";
import { loadSharingSample, loadSampleState } from "../sample.js";
import {
  generateRecoveryKey, normalizeRecoveryKey, inviteLink, initials, syncedAgo, contactId, uniqueName, nextColor,
} from "../core/sharing.js";
import { h, text, button } from "./dom.js";
import { qrFigure, scannerView, cameraScanner } from "./qr.js";
import { showSnackbar } from "./snackbar.js";
import { icon } from "./icons.js";

const $ = id => document.getElementById(id);
const real = () => !state.sync.simulated;
let stack = [];          // [{ page, data }]; the last entry is on screen
let isOpen = false;
let returnFocus = null;
let shownUsage = null;   // the `state.sync.usage` the overview was drawn with
let leave = null;        // turns off what the page on screen started (camera)

export function initSyncPanel() {
  $("syncBack").addEventListener("click", back);
  $("syncPanel").addEventListener("click", e => { if (e.target === $("syncPanel")) close(); });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && isOpen) { e.stopPropagation(); back(); }
  }, true);
  // Android back: the panel sits on one history entry; further pages go back inside it.
  window.addEventListener("popstate", () => {
    if (!isOpen) return;
    if (stack.length > 1) { stack.pop(); render(); history.pushState({ syncPanel: true }, ""); }
    else close({ fromHistory: true });
  });
  subscribe(kind => {
    if (kind !== "sync") return;
    updateStatus();
    // The first round after opening brings the usage: show it without a reopen.
    if (isOpen && top().page === "overview" && state.sync.usage !== shownUsage) render({ keepScroll: true });
  });
  setInterval(updateStatus, 20000);
  loadSharingSample();   // warm the sample identity for the simulated scans
}

/** The sync icon and ⋮ → "Sync & sharing…": opening the panel also syncs. */
export function openSyncPanel() {
  openPanel(state.sync.enabled ? "overview" : "off");
  syncOnRequest();
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
  history.pushState({ syncPanel: true }, "");
  render();
}

/** Pages other modules add to the container: { title, render(data), footer?(data) }. */
export function registerPage(name, def) {
  PAGES[name] = def;
}

/** Replaces the page stack with [[page, data], …] (the last is shown). */
export function setStack(entries) {
  stack = entries.map(([page, data = {}]) => ({ page, data }));
  render();
}

export function closePanel() { close(); }

function close({ fromHistory = false } = {}) {
  if (!isOpen) return;
  isOpen = false;
  leavePage();
  $("syncPanel").hidden = true;
  if (!fromHistory && history.state && history.state.syncPanel) history.back();
  if (returnFocus && returnFocus.focus) returnFocus.focus();
}

function back() {
  if (stack.length > 1) { stack.pop(); render(); } else close();
}

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

const section = title => h("h3", { class: "sheet-section" }, title);

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

function row({ icon: ic, avatar, title, sub, remove }) {
  return h("li", { class: "sheet-row" },
    avatar ? h("span", { class: "avatar", "aria-hidden": "true" }, avatar) : h("span", { class: "row-icon", html: icon(ic) }),
    h("span", { class: "row-text" }, h("span", { class: "row-title" }, title), sub && h("span", { class: "row-sub" }, sub)),
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
function action(label, run, cls = "primary") {
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

function addContact(name, via) {
  const id = contactId(name, state.sync.contacts.map(c => c.id));
  const contact = { id, name, via, color: nextColor(state.sync.contacts) };
  setSync({ contacts: [...state.sync.contacts, contact] });
  // Opened from the share dialog: go back to it with the new contact listed.
  const asker = stack.findLastIndex(e => e.data.onContactAdded);
  if (asker >= 0) {
    stack.length = asker + 1;
    stack[asker].data.onContactAdded(contact);
    render({ keepScroll: true });
  } else reset("overview");
  showSnackbar(`${name} added`);
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
      if (isOpen) reset("overview");
      showSnackbar("Device linked");
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

const PAGES = {
  off: {
    title: "Sync & sharing",
    render: () => [
      h("div", { class: "hero", html: icon("sync") }),
      text("Keep your notes in step on all your devices and share single notes with others. End-to-end encrypted — no account, no email."),
      real() && !syncAvailable()
        ? text("This copy of the app has no sync server.", "sheet-text muted")
        : h("div", { class: "sheet-actions" },
          button("Turn on sync", "primary", () => go("name")),
          button("Link to an existing device", "", () => go("link", { seed: "link-" + Math.random() }))),
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
        reset("overview");
        showSnackbar("Sync is on");
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
        reset("overview");
        showSnackbar("Device linked");
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
        else setSync({ devices: [...state.sync.devices, data.name] });
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

// The Storage section: used share of the server quota, hidden while unknown.
function storageSection() {
  const { usage } = state.sync;
  shownUsage = usage;
  if (!usage) return null;
  const u = storageUsage(usage);
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

// Real sync: this identity's devices (loaded from the server) and, until
// sharing is built, a note instead of the contacts.
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
      ? h("ul", { class: "sheet-card" }, data.rows.map(d => row({
          icon: "device", title: d.label, sub: d.own ? (d.named ? "This device" : deviceName()) : null,
          remove: !d.own && (() => go("removeDevice", d)),
        })))
      : text(data.failed ? `Couldn't load the devices: ${data.failed}` : "Loading…", "sheet-text muted"),
    h("div", { class: "button-row" }, button("Link a device", "outline", () => go("linkDevice"))),
    h("div", { class: "button-row" }, button("Sign out this device", "outline danger",
      () => go("signOut", { others: data.rows ? data.rows.length > 1 : null }))),
    section("Contacts"),
    text("Sharing notes with contacts comes in the next step.", "sheet-text muted"),
    storageSection(),
  ].flat();
}

// The sample: simulated devices and contacts.
function simulatedOverview() {
  const { devices, contacts } = state.sync;
  return [
    section("Devices"),
    h("ul", { class: "sheet-card" },
      row({ icon: "device", title: "This device", sub: deviceName() }),
      devices.map((name, i) => row({ icon: "device", title: name, remove: () => removeFromList("devices", i, name) }))),
    h("div", { class: "button-row" }, button("Link a device", "outline", () => go("linkDevice"))),
    h("div", { class: "button-row" }, button("Sign out this device", "outline danger", () => go("signOut", { others: devices.length > 0 }))),

    section("Contacts"),
    contacts.length
      ? h("ul", { class: "sheet-card" }, contacts.map((c, i) =>
          row({ avatar: initials(c.name), title: c.name, sub: c.via === "link" ? "Added by link" : null, remove: () => removeFromList("contacts", i, c.name) })))
      : text("No contacts yet. Add one to share notes with them.", "sheet-text muted"),
    h("div", { class: "button-row" },
      button("Add contact", "outline", () => go("addContact", { mode: "scan" })),
      button("My code", "outline", () => go("myCode"))),
    storageSection(),
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
            go("confirmLink", { name: uniqueName("New device", state.sync.devices) }))),
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
      if (data.mode === "link") {
        data.link ||= inviteLink();
        const field = h("input", { class: "input mono", type: "text", readonly: true, value: data.link, "aria-label": "Invitation link" });
        field.addEventListener("focus", () => field.select());
        return [
          tabs,
          text("Send this link through any messenger. Whoever opens it becomes your contact."),
          field,
          h("div", { class: "sheet-actions" }, button("Copy link", "primary", async () => {
            if (navigator.share && matchMedia("(pointer: coarse)").matches) {
              try { await navigator.share({ url: data.link }); return; } catch (e) { if (e.name === "AbortError") return; }
            }
            if (await copyText(data.link)) showSnackbar("Link copied");
            else { field.focus(); showSnackbar("Select the link and copy it"); }
          })),
        ];
      }
      return [
        tabs,
        scannerView("Scan the code on your contact's phone."),
        h("div", { class: "button-row center" }, button("Simulate scan (prototype)", "", async () => {
          const sample = await loadSharingSample();
          go("nameContact", { name: sample.scanSuggestion });
        })),
      ];
    },
  },

  nameContact: {
    title: "Name the contact",
    render: data => {
      const add = button("Add", "primary", () => addContact(data.name.trim(), "scan"));
      add.disabled = !data.name.trim();
      const input = textInput({ value: data.name, maxlength: "40", "aria-label": "Contact name" },
        v => { data.name = v; add.disabled = !v.trim(); }, () => { if (!add.disabled) add.click(); });
      return [
        field("Name", input, "Only you see this name. Your contact suggested it."),
        h("div", { class: "sheet-actions" }, add),
      ];
    },
  },

  myCode: {
    title: "My code",
    render: () => [
      h("div", { class: "qr-wrap" }, qrFigure("me:" + state.sync.name + state.sync.recoveryKey, "Your contact code")),
      h("p", { class: "qr-name" }, state.sync.name),
      text("Let a contact scan this code to connect.", "sheet-text center"),
    ],
  },
});

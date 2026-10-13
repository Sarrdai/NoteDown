// The "Sync & sharing" panel (⋮ → "Sync & sharing…"): turning on sync with a
// recovery key, linking a device, devices and contacts. Phone: a full-screen
// sheet; tablet and desktop: a centered dialog. Pages stack inside the panel;
// the back button, Esc and the Android back key go one page back, then close.
// Prototype only: no network, no real keys, no camera — "Simulate scan"
// stands in for scanning (docs/sync-and-sharing.md → "Identity and devices",
// "Contacts").
import { state, subscribe, setSync, replaceFiles } from "../store.js";
import { syncNow } from "../sync-sim.js";
import { loadSharingSample, loadSampleState } from "../sample.js";
import {
  generateRecoveryKey, normalizeRecoveryKey, inviteLink, initials, syncedAgo, contactId, uniqueName,
} from "../core/sharing.js";
import { qrFigure, scannerView } from "./qr.js";
import { showSnackbar } from "./snackbar.js";
import { icon } from "./icons.js";

const $ = id => document.getElementById(id);
let stack = [];          // [{ page, data }]; the last entry is on screen
let isOpen = false;
let returnFocus = null;

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
  subscribe(kind => { if (kind === "sync") updateStatus(); });
  setInterval(updateStatus, 20000);
  loadSharingSample();   // warm the sample identity for the simulated scans
}

export function openSyncPanel() {
  if (isOpen) return;
  isOpen = true;
  returnFocus = document.activeElement;
  stack = [{ page: state.sync.enabled ? "overview" : "off", data: {} }];
  $("syncPanel").hidden = false;
  history.pushState({ syncPanel: true }, "");
  render();
}

function close({ fromHistory = false } = {}) {
  if (!isOpen) return;
  isOpen = false;
  $("syncPanel").hidden = true;
  if (!fromHistory && history.state && history.state.syncPanel) history.back();
  if (returnFocus && returnFocus.focus) returnFocus.focus();
}

function back() {
  if (stack.length > 1) { stack.pop(); render(); } else close();
}

function go(page, data = {}) {
  stack.push({ page, data });
  render();
}

// Replaces the whole stack, e.g. back to the overview after a flow.
function reset(page) {
  stack = [{ page, data: {} }];
  render();
}

const top = () => stack[stack.length - 1];

function render({ keepScroll = false } = {}) {
  const { page, data } = top();
  const def = PAGES[page];
  $("syncTitle").textContent = def.title;
  const nested = stack.length > 1;
  $("syncBack").innerHTML = icon(nested ? "back" : "close");
  $("syncBack").setAttribute("aria-label", nested ? "Back" : "Close");
  const scroll = $("syncBody").scrollTop;
  $("syncBody").replaceChildren(...def.render(data));
  $("syncBody").scrollTop = keepScroll ? scroll : 0;
  $("syncTitle").focus({ preventScroll: true });
  const auto = $("syncBody").querySelector("[data-autofocus]");
  if (auto && matchMedia("(pointer: fine)").matches) auto.focus();
  updateStatus();
}

// ---------- small DOM helpers ----------

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...kids.flat().filter(k => k != null && k !== false));
  return el;
}

const text = (s, cls = "sheet-text") => h("p", { class: cls }, s);
const button = (label, cls, onclick) => h("button", { class: "btn " + cls, type: "button", onclick }, label);
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

function deviceName() {
  if (matchMedia("(min-width: 1024px)").matches) return "This browser";
  return matchMedia("(min-width: 600px)").matches ? "This tablet" : "This phone";
}

// ---------- status line ----------

function statusText() {
  const { status, lastSync } = state.sync;
  if (status === "syncing") return "Syncing…";
  if (status === "offline") return "Offline — changes sync when you're back online";
  return lastSync ? `Synced · ${syncedAgo(lastSync)}` : "Synced";
}

function updateStatus() {
  const el = isOpen && $("syncBody").querySelector("[data-sync-status]");
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
  setSync({ contacts: [...state.sync.contacts, { id, name, via }] });
  reset("overview");
  showSnackbar(`${name} added`);
}

// ---------- pages ----------

const PAGES = {
  off: {
    title: "Sync & sharing",
    render: () => [
      h("div", { class: "hero", html: icon("sync") }),
      text("Keep your notes in step on all your devices and share single notes with others. End-to-end encrypted — no account, no email."),
      h("div", { class: "sheet-actions" },
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
      const done = button("Done", "primary", () => {
        setSync({ enabled: true, name: data.name, recoveryKey: data.key, devices: [], contacts: [] });
        syncNow();
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
      const restore = () => {
        const key = normalizeRecoveryKey(input.value);
        error.hidden = !!key;
        if (!key) { error.textContent = "That doesn't look like a recovery key. It has 24 letters and digits."; input.focus(); return; }
        adoptIdentity(key, "Notes restored");
      };
      input.addEventListener("keydown", e => { if (e.key === "Enter") restore(); });
      return [
        h("div", { class: "qr-wrap" }, qrFigure(data.seed, "QR code of this device")),
        text("On a device that already syncs, open Sync & sharing → Link a device and scan this code."),
        button("Simulate scan (prototype)", "", () => adoptIdentity(null, "Device linked")),
        h("div", { class: "sheet-divider" }),
        field("Or enter your recovery key", input),
        error,
        h("div", { class: "sheet-actions" }, button("Restore", "primary", restore)),
      ];
    },
  },

  overview: {
    title: "Sync & sharing",
    render: () => {
      const { devices, contacts } = state.sync;
      return [
        h("div", { class: "sync-status", "data-sync-status": "", "data-status": state.sync.status },
          h("span", { class: "sync-dot", "aria-hidden": "true" }),
          h("span", { class: "sync-status-text", role: "status" }, statusText())),

        section("Devices"),
        h("ul", { class: "sheet-card" },
          row({ icon: "device", title: "This device", sub: deviceName() }),
          devices.map((name, i) => row({ icon: "device", title: name, remove: () => removeFromList("devices", i, name) }))),
        h("div", { class: "button-row" }, button("Link a device", "outline", () => go("linkDevice"))),

        section("Contacts"),
        contacts.length
          ? h("ul", { class: "sheet-card" }, contacts.map((c, i) =>
              row({ avatar: initials(c.name), title: c.name, sub: c.via === "link" ? "Added by link" : null, remove: () => removeFromList("contacts", i, c.name) })))
          : text("No contacts yet. Add one to share notes with them.", "sheet-text muted"),
        h("div", { class: "button-row" },
          button("Add contact", "outline", () => go("addContact", { mode: "scan" })),
          button("My code", "outline", () => go("myCode"))),
      ];
    },
  },

  linkDevice: {
    title: "Link a device",
    render: () => [
      scannerView("Scan the code shown on the new device."),
      h("div", { class: "button-row center" }, button("Simulate scan (prototype)", "", () => {
        const name = uniqueName("New device", state.sync.devices);
        setSync({ devices: [...state.sync.devices, name] });
        reset("overview");
        showSnackbar("Device linked");
      })),
    ],
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
};

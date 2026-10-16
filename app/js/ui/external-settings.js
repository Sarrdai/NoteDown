// The "Links & media" setting (backlog #30): what this device does with
// images and videos from other websites and with links — a default for all
// notes and, per circle (Private, each contact, each group), an own choice.
// This device only, never synced: a note someone else wrote (or a device
// someone got hold of) must not decide what the user's other devices load.
// Prototype: where the per-circle choice is made is open —
// variant "dialog" (A) lists every circle in this dialog, variant "people"
// (B) keeps the dialog to the default and sets a circle from its long-press
// menu under People.
import { setCirclePolicy, DEFAULT_EXTERNAL } from "../core/external.js";
import { circleEntries } from "../core/sharing.js";
import { state, updateSettings, contacts, sharedCircles } from "../store.js";
import { circleName } from "./people-list.js";
import { nameOf } from "./people.js";
import { h, pushEntry, leaveEntry } from "./dom.js";

const $ = id => document.getElementById(id);
export const MEDIA_LABELS = { auto: "Load automatically", click: "Tap to load", never: "Never load" };
export const LINK_LABELS = { open: "Open directly", confirm: "Ask first", off: "Not clickable" };
const KINDS = [["media", "Images & videos", MEDIA_LABELS], ["links", "Links", LINK_LABELS]];

let openKey;   // undefined while closed; null = the default (with the circle list in variant A); else a circleKey

const external = () => ({ ...DEFAULT_EXTERNAL, ...state.settings.external });

/** Opens the dialog for the default (`key` null) or for one circle. */
export function openExternalDialog(key = null) {
  const first = openKey === undefined;
  openKey = key;
  render();
  $("extDialog").hidden = false;
  if (first) pushEntry({ extSettings: true });
  $("extDone").focus({ preventScroll: true, focusVisible: false });
}

function select(value, labels, onChange, def) {
  // `def`: the circle's first choice "Default" follows the default for all notes.
  const options = [...(def ? [["", "Default"]] : []), ...Object.entries(labels)];
  const el = h("select", { class: "ext-select", onchange: e => onChange(e.target.value || null) },
    ...options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)));
  return el;
}

function row(label, control, sub) {
  return h("label", { class: "setting-row ext-row" },
    h("span", { class: "setting-text" }, h("span", { class: "setting-label" }, label), sub ? h("span", { class: "setting-sub" }, sub) : null),
    control);
}

function setDefault(kind, value) {
  updateSettings({ external: { ...external(), [kind]: value } });
  render();
}

function setCircle(key, kind, value) {
  updateSettings({ external: setCirclePolicy(external(), key, kind, value) });
  render();
}

function render() {
  const s = external();
  const variant = state.settings.protoExtSettings;
  const body = [];
  if (openKey === null) {
    $("extTitle").textContent = "Links & media";
    $("extHint").textContent = "On this device only — not synced. Pictures and videos from other websites let that website see when you read the note.";
    body.push(...KINDS.map(([kind, label, labels]) => row(label, select(s[kind], labels, v => setDefault(kind, v)))));
    if (variant === "dialog") {
      body.push(h("h3", { class: "ext-section" }, "Per circle"));
      const circles = circleEntries(contacts(), sharedCircles(), nameOf).filter(e => e.kind !== "all");
      for (const e of circles) {
        const own = s.circles[e.key] || {};
        body.push(h("div", { class: "ext-circle" },
          h("div", { class: "ext-circle-name" }, circleName(e.key, e.members)),
          ...KINDS.map(([kind, label, labels]) => h("label", { class: "ext-circle-row" },
            h("span", { class: "ext-circle-kind" }, label),
            select(own[kind] || "", labels, v => setCircle(e.key, kind, v), true)))));
      }
    } else {
      body.push(h("p", { class: "dialog-hint setting-note" }, "A circle can have its own setting: long-press it under People (desktop: right-click)."));
    }
  } else {
    const own = s.circles[openKey] || {};
    $("extTitle").textContent = `Links & media · ${circleName(openKey)}`;
    $("extHint").textContent = "For the notes in this circle, on this device only.";
    body.push(...KINDS.map(([kind, label, labels]) => row(label, select(own[kind] || "", labels, v => setCircle(openKey, kind, v), true), `Default: ${labels[s[kind]]}`)));
    body.push(h("button", { class: "link-btn ext-all", type: "button", onclick: () => openExternalDialog(null) }, "Default for all notes…"));
  }
  $("extBody").replaceChildren(...body);
}

/** The entry a circle's long-press menu shows (variant B). */
export function circleMenuEntry(key) {
  return { label: "Links & media…", icon: "link", onSelect: () => openExternalDialog(key) };
}

function close({ fromHistory = false } = {}) {
  if (openKey === undefined) return;
  openKey = undefined;
  $("extDialog").hidden = true;
  if (!fromHistory) leaveEntry("extSettings");
}

export function initExternalSettings() {
  $("extDone").addEventListener("click", () => close());
  $("extDialog").addEventListener("click", e => { if (e.target === $("extDialog")) close(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && openKey !== undefined) { e.stopPropagation(); close(); } }, true);
  window.addEventListener("popstate", () => { if (openKey !== undefined) close({ fromHistory: true }); });
}

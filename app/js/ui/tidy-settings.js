// Settings → "Tidy-up reminder": the pile gauge's numbers — how many bars, one
// bar per how many notes and per how many days of the oldest note — the same
// for every circle, and per circle (Private, each contact, each group) whether
// its notes count (core/tidy.js). Private counts by default, shared circles
// are ignored. This device only, never synced, like the other settings.
import { TIDY_LIMITS, tidyConfig, tidyCounted, tidyLevel } from "../core/tidy.js";
import { circleEntries } from "../core/sharing.js";
import { state, updateSettings, contacts, sharedCircles } from "../store.js";
import { circleName } from "./people-list.js";
import { nameOf } from "./people.js";
import { registerPage, refreshPage, section } from "./sync-panel.js";
import { h } from "./dom.js";

const circles = () => circleEntries(contacts(), sharedCircles(), nameOf).filter(e => e.kind !== "all");
const tidy = () => state.settings.tidy || {};
const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The settings overview's line: the numbers, or "Off" when no circle counts. */
export function tidySummary() {
  if (!circles().some(e => tidyCounted(tidy(), e.key))) return "Off";
  const { bars, notes, days } = tidyConfig(tidy());
  return `${plural(bars, "bar")} · 1 per ${plural(notes, "note")} · 1 per ${plural(days, "day")}`;
}

// A row with − value + for one of the numbers.
function stepper(key, label) {
  const [min, max] = TIDY_LIMITS[key];
  const value = tidyConfig(tidy())[key];
  const set = v => { updateSettings({ tidy: { ...tidy(), ...tidyConfig(tidy()), [key]: v } }); refreshPage({ keepScroll: true }); };
  return h("div", { class: "setting-row tidy-row" },
    h("span", { class: "setting-label" }, label),
    h("span", { class: "tidy-stepper" },
      h("button", { class: "icon-btn", disabled: value <= min, "aria-label": label + ": fewer", onclick: () => set(value - 1) }, "−"),
      h("output", { "aria-live": "polite" }, String(value)),
      h("button", { class: "icon-btn", disabled: value >= max, "aria-label": label + ": more", onclick: () => set(value + 1) }, "+")));
}

// The gauge as it looks at each fill: grey, yellow shortly before full, red when full.
function preview() {
  const { bars } = tidyConfig(tidy());
  return h("div", { class: "tidy-preview", "aria-hidden": "true" },
    ...[Math.ceil(bars / 2), bars - 1, bars].filter((f, i, a) => f > 0 && a.indexOf(f) === i).map(f =>
      h("span", { class: "pile-gauge level-" + tidyLevel(f, bars) },
        ...Array.from({ length: bars }, (_, i) => h("i", { class: i < f ? "on" : "" })))));
}

registerPage("settingsTidy", {
  title: "Tidy-up reminder",
  render: () => [
    h("p", { class: "sheet-text" }, "New notes land on the pile until they are put on a shelf (sorted by Shelves). Its gauge fills one bar for every few notes on it and one for every few days its oldest note has waited; it turns yellow shortly before full and red when full. On this device only — not synced."),
    section("Gauge"),
    stepper("bars", "Bars"),
    stepper("notes", "Notes per bar"),
    stepper("days", "Days per bar"),
    preview(),
    section("Circles"),
    h("p", { class: "sheet-text muted" }, "An ignored circle shows no gauge, and its notes don't count where several circles show together."),
    ...circles().map(e => h("label", { class: "setting-row" },
      h("span", { class: "setting-label" }, circleName(e.key, e.members)),
      h("input", { type: "checkbox", class: "switch", role: "switch", checked: tidyCounted(tidy(), e.key),
        "aria-label": "Count " + circleName(e.key, e.members),
        onchange: ev => {
          updateSettings({ tidy: { ...tidy(), circles: { ...tidy().circles, [e.key]: ev.target.checked } } });
          refreshPage({ keepScroll: true });
        } }))),
  ],
});

// Settings → "Tidy-up reminder": per circle (Private, each contact, each
// group) when My order's pile is due for tidying, or off (core/tidy.js).
// Private is on by default, shared circles off. This device only, never
// synced, like the other settings. Listed per circle as on the Links & media
// page, so every circle's choice shows at a glance.
import { TIDY_CHOICES, tidyChoice } from "../core/tidy.js";
import { circleEntries } from "../core/sharing.js";
import { state, updateSettings, contacts, sharedCircles } from "../store.js";
import { circleName } from "./people-list.js";
import { nameOf } from "./people.js";
import { registerPage, refreshPage, section } from "./sync-panel.js";
import { h } from "./dom.js";
import { pickButton } from "./menu.js";

export const TIDY_LABELS = { off: "Off", often: "5 notes · 3 days", normal: "10 notes · 1 week", rarely: "20 notes · 4 weeks" };

const circles = () => circleEntries(contacts(), sharedCircles(), nameOf).filter(e => e.kind !== "all");

/** The settings overview's line: Private's choice, and how many shared circles have it on. */
export function tidySummary() {
  const own = tidyChoice(state.settings.tidy, "");
  const shared = circles().filter(e => e.key !== "" && tidyChoice(state.settings.tidy, e.key) !== "off").length;
  return `Private: ${own === "off" ? "off" : TIDY_LABELS[own]}` + (shared ? ` · ${shared} shared ${shared === 1 ? "circle" : "circles"} on` : "");
}

registerPage("settingsTidy", {
  title: "Tidy-up reminder",
  render: () => [
    h("p", { class: "sheet-text" }, "New notes land on the pile of My order. Once a circle's notes on it reach the number or the oldest reaches the age, the pile and the sort button say it is time to tidy up. On this device only — not synced."),
    section("Per circle"),
    ...circles().map(e => h("div", { class: "setting-row ext-row" },
      h("span", { class: "setting-label" }, circleName(e.key, e.members)),
      pickButton(tidyChoice(state.settings.tidy, e.key), TIDY_CHOICES.map(c => [c, TIDY_LABELS[c]]), v => {
        updateSettings({ tidy: { ...state.settings.tidy, [e.key]: v } });
        refreshPage({ keepScroll: true });
      }, { cls: "ext-select tidy-select", label: "Tidy-up reminder for " + circleName(e.key, e.members) }))),
  ],
});

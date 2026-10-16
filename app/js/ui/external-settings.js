// Settings → "Links & media" (backlog #30): what this device does with
// images and videos from other websites and with links — a default for all
// notes and below it every circle (Private, each contact, each group) with
// its own choice or "Default". This device only, never synced: a note
// someone else wrote (or a device someone got hold of) must not decide what
// the user's other devices load. Decided 2026-10-16: the circles listed on
// this page, over a long-press on the circle under People (no overview of
// the exceptions).
import { setCirclePolicy, DEFAULT_EXTERNAL } from "../core/external.js";
import { circleEntries } from "../core/sharing.js";
import { state, updateSettings, contacts, sharedCircles } from "../store.js";
import { circleName } from "./people-list.js";
import { nameOf } from "./people.js";
import { registerPage, refreshPage, section } from "./sync-panel.js";
import { h } from "./dom.js";

export const MEDIA_LABELS = { auto: "Load automatically", click: "Tap to load", never: "Never load" };
export const LINK_LABELS = { open: "Open directly", confirm: "Ask first", off: "Not clickable" };
const KINDS = [["media", "Images & videos", MEDIA_LABELS], ["links", "Links", LINK_LABELS]];

const external = () => ({ ...DEFAULT_EXTERNAL, ...state.settings.external });

/** The settings overview's line: the default for all notes, and how many circles have their own. */
export function externalSummary() {
  const s = external();
  const own = Object.keys(s.circles).length;
  return `${MEDIA_LABELS[s.media]} · ${LINK_LABELS[s.links]}` + (own ? ` · ${own} ${own === 1 ? "circle differs" : "circles differ"}` : "");
}

// `withDefault`: a circle's choice, whose first option "Default" follows the default for all notes.
function select(value, labels, onChange, withDefault = false) {
  const options = [...(withDefault ? [["", "Default"]] : []), ...Object.entries(labels)];
  return h("select", { class: "ext-select", onchange: e => onChange(e.target.value || null) },
    ...options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)));
}

function change(settings) {
  updateSettings({ external: settings });
  refreshPage({ keepScroll: true });
}

registerPage("settingsLinks", {
  title: "Links & media",
  render: () => {
    const s = external();
    const circles = circleEntries(contacts(), sharedCircles(), nameOf).filter(e => e.kind !== "all");
    return [
      h("p", { class: "sheet-text" }, "On this device only — not synced. Pictures and videos from other websites let that website see when you read the note."),
      section("All notes"),
      ...KINDS.map(([kind, label, labels]) => h("label", { class: "setting-row ext-row" },
        h("span", { class: "setting-label" }, label),
        select(s[kind], labels, v => change({ ...s, [kind]: v })))),
      section("Per circle"),
      ...circles.map(e => {
        const own = s.circles[e.key] || {};
        return h("div", { class: "ext-circle" },
          h("div", { class: "ext-circle-name" }, circleName(e.key, e.members)),
          ...KINDS.map(([kind, label, labels]) => h("label", { class: "ext-circle-row" },
            h("span", { class: "ext-circle-kind" }, label),
            select(own[kind] || "", labels, v => change(setCirclePolicy(s, e.key, kind, v)), true))));
      }),
    ];
  },
});

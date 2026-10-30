// Verifying a contact (backlog #4, docs/sync-and-sharing.md → "Contacts"): a
// contact scanned in person is verified; one added by an invitation link is
// only as safe as the messenger it came through. The user verifies it later
// by scanning the contact's code or by comparing the safety code both phones
// compute from the two identities. The page lives in the Sync & sharing
// panel's container and is reached from the contact list and the share dialog.
import { state, setSync, contacts, updateContact, sharedCircles, subscribe } from "../store.js";
import { timestamp } from "../core/notes-file.js";
import { safetyCode } from "../core/crypto.js";
import { readInvite } from "../sync/contacts.js";
import { registerPage, go, popPage, onLeave, panelPage, refreshPage, resetPanel, closePanel, section } from "./sync-panel.js";
import { groupsWith, circleKey, SAFETY_VARIANTS, safetyVariant, safetyLines } from "../core/sharing.js";
import { circleName, pickCircle } from "./people-list.js";
import { h, text, button } from "./dom.js";
import { scannerView, cameraScanner } from "./qr.js";
import { avatarHtml, avatarStackHtml } from "./people.js";
import { icon } from "./icons.js";
import { showSnackbar } from "./snackbar.js";

const codes = new Map();   // "<variant>:<contact id>" → promise of the safety code

const contactOf = id => contacts().find(c => c.id === id);

// The user's own identity: the real identity ID, in the sample a stand-in from the sample name.
const me = () => state.sync.identity || "sample:" + state.sync.name;

// The safety code's length: a prototype variant (⋮ → "Prototype: Safety code", core/sharing.js → SAFETY_VARIANTS).
const variant = () => safetyVariant(state.settings.safetyCode);

function codeOf(id, v) {
  const key = `${v}:${id}`;
  if (!codes.has(key)) codes.set(key, safetyCode(me(), id, SAFETY_VARIANTS[v].groups));
  return codes.get(key);
}

/** Marks contact `id` as verified, leaves the verify pages and says so, with Undo. */
export function markVerified(id) {
  const c = contactOf(id);
  if (!c) return;
  updateContact(id, { verified: timestamp() });
  for (let i = 0; i < 3 && ["verifyContact", "codeDiffers"].includes(panelPage()); i++) popPage();
  showSnackbar(`${c.name} verified`, () => updateContact(id, { verified: undefined }));
}

// The safety code: each identity's part on a line of its own or on several, the identities in the order of their IDs
// (so both phones show the same); dots in the same shape until it is computed.
function codeView(id) {
  const v = variant(), { groups, perLine } = SAFETY_VARIANTS[v];
  const el = h("p", { class: "safety-code", "aria-label": "Safety code" });
  const draw = parts => el.replaceChildren(...parts.map(part =>
    h("span", { class: "safety-part" }, safetyLines(part, perLine).map(line => h("span", { class: "safety-line" }, line)))));
  draw([0, 1].map(() => Array(groups).fill("·····")));
  codeOf(id, v).then(parts => { draw(parts); el.setAttribute("aria-label", "Safety code " + parts.flat().join(" ")); });
  return el;
}

// Switching the variant redraws an open Verify contact page.
let drawn = null;   // the variant the page on screen was drawn with
subscribe(kind => {
  if (kind === "structure" && panelPage() === "verifyContact" && drawn !== variant()) refreshPage({ keepScroll: true });
});

function hero(c) {
  return h("div", { class: "request-hero" },
    h("span", { html: avatarHtml(c.id, "large") }).firstChild,
    h("p", { class: "request-title" }, c.name),
    c.verified
      ? h("p", { class: "verify-state ok" }, h("span", { html: icon("check") }), "Verified")
      : h("p", { class: "verify-state" }, h("span", { html: icon("protect") }), "Not verified"));
}

// The groups the contact is in (user request 2026-10-16); a tap shows that group's notes.
function groups(c) {
  const keys = groupsWith(c.id, sharedCircles()).map(m => circleKey(m));
  return [
    section("Groups"),
    keys.length
      ? h("ul", { class: "sheet-card" }, keys.map(k => h("li", { class: "sheet-row" },
          h("button", { class: "row-open", type: "button", onclick: () => { closePanel(); pickCircle(k); } },
            h("span", { class: "row-icon", html: avatarStackHtml(k.split("+")) }),
            h("span", { class: "row-text" }, h("span", { class: "row-title" }, circleName(k)))))))
      : text(`${c.name} isn't in any group yet. A note shared with ${c.name} and others starts one.`, "sheet-text muted"),
  ];
}

// Comparing the safety code: both phones show the same code for the pair.
function compare(c) {
  const parts = [
    codeView(c.id),
    text(`${c.name} sees the same code on their phone, under Sync & sharing → ${state.sync.name || "your name"}. Compare it, e.g. read it out on a call.`, "sheet-text muted center"),
  ];
  if (!c.verified) {
    parts.push(h("div", { class: "sheet-actions" },
      button("Codes match", "primary", () => markVerified(c.id)),
      button("They differ", "outline", () => go("codeDiffers", { id: c.id }))));
  }
  return parts;
}

// Scanning the contact's code: their "My code" carries their identity.
function scan(c) {
  const hint = `Scan the code on ${c.name}'s phone (Sync & sharing → My code).`;
  if (!real()) {
    return [
      scannerView(hint),
      h("div", { class: "button-row center" }, button("Simulate scan (prototype)", "", () => markVerified(c.id))),
    ];
  }
  const scanner = cameraScanner({
    hint,
    wrongCode: `That's not ${c.name}'s code.`,
    noCamera: "No camera found on this device. Compare the safety code instead.",
    onCode: value => {
      const found = readInvite(value);
      if (!found || found.identity !== c.id) return false;
      markVerified(c.id);
      return true;
    },
  });
  onLeave(scanner.stop);
  return [scanner.el];
}

const real = () => !state.sync.simulated;

const intro = c => text(`${c.name} was added by an invitation link, which is only as safe as the way it was sent. Check that it's really them before you share anything private.`, "sheet-text center");

// Two tabs, like Add contact: "Compare code" (the usual way for a contact far away) and "Scan code"
// (decided 2026-10-14 over one page with the code first and scanning below). A verified contact shows
// only its safety code, to check again.
function layout(c, data) {
  if (c.verified) return [h("h3", { class: "sheet-section" }, "Safety code"), ...compare(c)];
  const tabs = h("div", { class: "segmented", role: "tablist" }, [["code", "Compare code"], ["scan", "Scan code"]].map(([id, label]) =>
    h("button", { class: "segment", role: "tab", type: "button", "aria-selected": String(data.tab === id), onclick: () => { data.tab = id; refreshPage(); } }, label)));
  return [intro(c), tabs, ...(data.tab === "scan" ? scan(c) : compare(c))];
}

registerPage("verifyContact", {
  title: data => contactOf(data.id)?.verified ? "Contact" : "Verify contact",
  render: data => {
    drawn = variant();
    const c = contactOf(data.id);
    if (!c) return [text("This contact is no longer in your list.", "sheet-text muted")];
    return [hero(c), ...groups(c), ...layout(c, data)];
  },
});

registerPage("codeDiffers", {
  title: "Codes differ",
  render: data => {
    const c = contactOf(data.id);
    if (!c) return [];
    return [
      h("div", { class: "hero", html: icon("protect") }),
      text(`The codes must be exactly the same. If they differ, the contact you have may not be ${c.name}: someone could have swapped the invitation link on the way.`, "sheet-text center"),
      text(`Don't share with this contact. Remove it and add ${c.name} again, best by scanning their code in person.`, "sheet-text center"),
      h("div", { class: "sheet-actions" }, button("Remove contact", "danger", () => {
        if (real()) return go("removeContact", { id: c.id, name: c.name });
        setSync({ contacts: state.sync.contacts.filter(x => x.id !== c.id) });
        resetPanel("overview");
        showSnackbar(`${c.name} removed`);
      })),
    ];
  },
});

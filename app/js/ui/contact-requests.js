// Incoming contact requests (docs/sync-and-sharing.md → "Contacts"): someone
// who scanned this user's code or opened their invitation link asks to
// become a contact, and this user confirms or declines. The requests come
// from the server in each sync round (sync/contacts.js) and are simulated in
// the sample; both are in `state.sync.requests`. A request shows as a card above the open
// notes until it is decided (chosen 2026-10-14 over a dialog that opens by
// itself, which interrupts, and a dot on the sync icon, easy to miss), and
// in Sync & sharing → "Contact requests". Shared files from people who aren't contacts, held back until the user
// accepts them (core/strangers.js), ask the same way: a card with "Show" and "Leave".
import { state, subscribe, setSync, heldRequests, acceptShared, leaveHeld } from "../store.js";
import { registerPage, openPanel, go, isPanelOpen, panelPage, panelData, addContact, contactAdded, closePanel, action } from "./sync-panel.js";
import { confirmRequest, declineRequest } from "../sync/contacts.js";
import { loadSharingSample } from "../sample.js";
import { h, text, button } from "./dom.js";
import { requestAvatarHtml, requestHow as how, membersLabel, avatarHtml, avatarStackHtml } from "./people.js";
import { showSnackbar } from "./snackbar.js";

const $ = id => document.getElementById(id);

const requestAvatar = (r, cls) => h("span", { html: requestAvatarHtml(r, cls) }).firstChild;

export function initContactRequests() {
  subscribe(update);
  update();
}

/** Shows the cards again once the stored files are loaded (the cards were set up before). */
export const refreshContactRequests = update;

function update() {
  const requests = state.sync.enabled ? state.sync.requests || [] : [];
  const held = state.sync.enabled ? heldRequests() : [];
  renderCards(state.view === "open" ? requests : [], state.view === "open" ? held : []);
  // On "My code" the request is what the user waits for: show it at once (the real code's own request).
  if (isPanelOpen() && panelPage() === "myCode") {
    const mine = state.sync.simulated ? requests[0] : requests.find(r => r.id === panelData().invite?.id);
    if (mine) go("contactRequest", { request: mine });
  }
}

const heldAvatar = members => h("span", { html: members.length === 1 ? avatarHtml(members[0]) : avatarStackHtml(members) }).firstChild;

function renderCards(requests, held) {
  const box = $("requestCards");
  const heldLabels = held.map(f => membersLabel(f.members));
  const ids = [...requests.map(r => r.id), ...held.map((f, i) => `${f.key}:${heldLabels[i]}`)].join("|");
  if (box.dataset.ids === ids) return;
  box.dataset.ids = ids;
  box.hidden = !requests.length && !held.length;
  box.replaceChildren(...held.map((f, i) => h("div", { class: "request-card held-card", role: "group", "aria-label": `Note from ${heldLabels[i]}` },
    heldAvatar(f.members),
    h("span", { class: "row-text" }, h("span", { class: "row-title" }, `${heldLabels[i]} shared a note with you`)),
    h("div", { class: "request-actions" },
      button("Leave", "", () => leaveHeld(f.key)),
      button("Show", "primary", () => acceptShared(f.key))))),
  ...requests.map(r => h("div", { class: "request-card", role: "group", "aria-label": `Contact request from ${r.name}` },
    requestAvatar(r),
    h("span", { class: "row-text" }, h("span", { class: "row-title" }, `${r.name} wants to be your contact`), h("span", { class: "row-sub" }, how(r))),
    h("div", { class: "request-actions" },
      button("Decline", "", () => decline(r)),
      button("Confirm", "primary", () => openPanel("contactRequest", { request: r }))))));
}

function take(r) {
  setSync({ requests: state.sync.requests.filter(x => x.id !== r.id) });
}

function decline(r, { closing = false } = {}) {
  const index = state.sync.requests.findIndex(x => x.id === r.id);
  take(r);
  // Real: the invitation is deleted on the server once the Undo window is over.
  const keep = state.sync.simulated ? null : declineRequest(r.id);
  if (closing) closePanel();
  showSnackbar("Request declined", () => {
    if (keep) keep();
    const list = [...state.sync.requests];
    list.splice(index, 0, r);
    setSync({ requests: list });
  });
}

/** ⋮ → "Simulate contact request": the sample's requester asks (as after a sync round). */
export async function simulateRequest() {
  const { request } = await loadSharingSample();
  const taken = new Set([...state.sync.requests, ...state.sync.contacts].map(x => x.id));
  let id = "req-" + request.name.toLowerCase();
  for (let i = 2; taken.has(id); i++) id = `req-${request.name.toLowerCase()}-${i}`;
  setSync({ requests: [...state.sync.requests, { id, name: request.name, via: request.via, inPerson: request.via === "scan" }] });
}

registerPage("contactRequest", {
  title: "Contact request",
  render: data => {
    const r = data.request;
    data.name ??= r.name;
    const { btn: confirm, error } = action("Confirm", async () => {
      if (state.sync.simulated) { take(r); addContact(data.name.trim(), r.via); return; }
      contactAdded(await confirmRequest(r.id, data.name.trim()));
    });
    confirm.disabled = !data.name.trim();
    const input = h("input", {
      type: "text", class: "input", autocomplete: "off", autocapitalize: "words", spellcheck: "false", maxlength: "40",
      "aria-label": "Contact name", value: data.name, "data-autofocus": true,
      oninput: e => { data.name = e.target.value; confirm.disabled = !data.name.trim(); },
      onkeydown: e => { if (e.key === "Enter" && !confirm.disabled) confirm.click(); },
    });
    return [
      h("div", { class: "request-hero" }, requestAvatar(r, "large"),
        h("p", { class: "request-title" }, `${r.name} wants to be your contact`),
        text(`${how(r)}.`, "sheet-text muted center")),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Name"), input,
        h("span", { class: "field-hint" }, `Only you see this name. ${r.name} suggested it.`)),
      h("div", { class: "sheet-actions" }, confirm, button("Decline", "outline", () => decline(r, { closing: true }))),
      error,
    ];
  },
});

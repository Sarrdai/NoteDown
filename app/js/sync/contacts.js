// Real contacts (docs/server-api.md → "Contacts and invitations"): creating
// invitations (the "My code" QR code and invitation links), sending a contact
// request through one, confirming or declining requests, and the contact
// list in the private file (docs/file-format.md → "Contacts"). Each sync round
// calls `contactsRound` after the files: it brings the requests that wait for
// this user and the confirmations of requests this user sent. The sample
// (`state.sync.simulated`) never reaches this module.
import { state, setSync, contacts, setContacts } from "../store.js";
import { timestamp } from "../core/notes-file.js";
import { nextColor } from "../core/sharing.js";
import { invitationLink, parseInvitationLink, contactCard, parseContactCard } from "../core/linking.js";
import * as c from "../core/crypto.js";
import { ApiError } from "./api.js";
import { pinnedChain } from "./pins.js";

const MAX_NAME = 40;
const CODE_MARGIN_MS = 30000;     // a code with less time left is replaced by a new one
const DECLINE_UNDO_MS = 6000;     // a declined request is deleted on the server after the snackbar's Undo window

/** Shown when a code or link can't be used (any more). */
export const GONE = "This code or link has expired or was already used";

let ctx = null;                   // { api(server), home(), defaultServer(), keys(), loadKeys(), chain(), web() }, from sync/client.js
let code = null;                  // promise of the open "My code" invitation
const codes = new Set();          // ids of the "My code" invitations this device showed: their requests were made in person
const checked = new Map();        // "<invitation id>:<requester>" → the verified request, or null
const declined = new Set();       // invitation ids declined and waiting for their DELETE
const confirmedListeners = new Set();

/** Hands over what the sync client owns: the API, this device's keys, the verified device list, the web address of invitation links. */
export function initContacts(context) {
  ctx = context;
}

/** Calls `fn(contact)` when a request this user sent is confirmed during a sync round. */
export function onContactConfirmed(fn) {
  confirmedListeners.add(fn);
}

const cleanName = name => name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);

// ---------- invitations ----------

/**
 * A new invitation of `kind` ("code": open 10 minutes, "link": 7 days): a fresh secret, the invitation
 * registered on the server, signed by this device. → { id, kind, text (the link), expires (ms) }.
 */
export async function createInvitation(kind) {
  await ctx.loadKeys();
  const web = ctx.web();
  if (!web) throw new Error("This copy of the app has no web address for invitation links.");
  const secret = c.newInvitationSecret();
  const id = await c.invitationId(secret);
  const sig = await c.signInvitation(ctx.keys().sign.privateKey, id);
  let created;
  try {
    created = await ctx.api().createInvitation(id, kind, sig);
  } catch (e) {
    if (e instanceof ApiError && e.status === 413 && /invitations/.test(e.body.detail || "")) {
      throw new Error("You have too many open invitations. Wait until some expire or are answered.");
    }
    throw e;
  }
  const text = invitationLink({ web, identity: state.sync.identity, secret: c.b64u(secret), name: state.sync.name, server: ctx.home() });
  return { id, kind, text, expires: Date.parse(created.expires) };
}

/** The invitation "My code" shows: the open one while it has time left, else a new one. */
export function myCode() {
  if (code) {
    const open = code;
    return open.then(inv => (inv.expires - Date.now() > CODE_MARGIN_MS ? inv : renewCode()), () => renewCode());
  }
  return renewCode();
}

function renewCode() {
  code = createInvitation("code");
  code.then(inv => codes.add(inv.id), () => { code = null; });
  return code;
}

/** `{ identity, name, contact }` of an invitation link (the text of a scanned code or a pasted link), else null;
 *  `contact` is the contact with that identity when there is one already (scanning their code verifies it). */
export function readInvite(text) {
  const invite = parseInvitationLink(text);
  return invite && { identity: invite.identity, name: invite.name, contact: contacts().find(x => x.id === invite.identity) || null };
}

// ---------- requesting ----------

/**
 * Sends a contact request through the invitation in `text` and lists the inviter as a pending contact
 * named `name` (`verified` when the code was scanned in person with NoteDown's scanner; an opened or
 * pasted link may have been swapped on the way, backlog #4): reads the inviter's device list with the invitation, checks that it belongs to the
 * identity in the link, seals this user's card for each of the inviter's devices and posts it.
 */
export async function sendRequest(text, name, { verified = false } = {}) {
  const invite = parseInvitationLink(text);
  if (!invite) throw new Error("That's not a NoteDown invitation.");
  if (invite.identity === state.sync.identity) throw new Error("That's your own code.");
  const known = contacts().find(x => x.id === invite.identity);
  if (known) throw new Error(known.pending ? `You already sent a request to ${known.name}.` : `${known.name} is already your contact.`);
  await ctx.loadKeys();
  const api = ctx.api(invite.server || ctx.defaultServer());   // the inviter's home server
  const id = await c.invitationId(c.fromB64u(invite.secret, 16));
  let targets;
  try {
    const { identity_key: identityKey, entries } = await api.getIdentity(invite.identity, id);
    const key = c.fromB64u(identityKey, 32);
    if (await c.keyId(key) !== invite.identity) throw new c.ProtocolError("wrong identity key");
    targets = [...(await pinnedChain(invite.identity, key, entries)).values()].filter(d => d.active && d.kind === "device");
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) throw new Error(GONE);
    if (e instanceof c.ProtocolError) throw new Error("This invitation can't be trusted.");
    throw e;
  }
  if (!targets.length) throw new Error(GONE);
  const card = contactCard(state.sync.identity, state.sync.name, invite.secret);
  const cards = Object.fromEntries(await Promise.all(targets.map(async d => [d.id, await c.sealContactCard(card, d)])));
  try {
    await api.sendRequest(id, cards);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 409)) throw new Error(GONE);
    if (e instanceof ApiError && e.status === 403) throw new Error("That's your own code.");
    throw e;
  }
  const contact = { id: invite.identity, name: cleanName(name), color: nextColor(contacts()), ...(invite.server && invite.server !== ctx.defaultServer() && { server: invite.server }), pending: timestamp(),
    ...(verified && { verified: timestamp() }), ...(invite.display && { display: true }) };
  setContacts([...contacts(), contact]);
  return contact;
}

// ---------- answering requests ----------

const dropRequest = id => setSync({ requests: state.sync.requests.filter(r => r.id !== id) });

/** Confirms the request of invitation `id`, naming the new contact `name`. → the contact. */
export async function confirmRequest(id, name) {
  const request = state.sync.requests.find(r => r.id === id);
  if (!request) throw new Error("This request is no longer available.");
  try {
    await ctx.api().confirmContact(id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) { dropRequest(id); throw new Error("This request is no longer available."); }
    throw e;
  }
  dropRequest(id);
  // Both sides may have invited each other: the entry already there is confirmed. A code this device
  // showed was scanned in person, so the contact is verified; a link is only as safe as the way it came,
  // and the server's word on an invitation's kind is not proof (backlog #4).
  const known = contacts().find(x => x.id === request.identity);
  const verified = known?.verified || (request.inPerson ? timestamp() : null);
  const contact = { ...known, id: request.identity, name: cleanName(name), color: known ? known.color : nextColor(contacts()), ...(verified && { verified }) };
  delete contact.pending;
  setContacts([...contacts().filter(x => x.id !== contact.id), contact]);
  return contact;
}

/**
 * Declines the request of invitation `id`: it disappears at once and the invitation is deleted on the
 * server after the Undo window. → a function that takes the decline back.
 */
export function declineRequest(id) {
  declined.add(id);
  const timer = setTimeout(async () => {
    try { await ctx.api().deleteInvitation(id); } catch { /* it shows up again in a later round */ }
    declined.delete(id);
  }, DECLINE_UNDO_MS);
  return () => { clearTimeout(timer); declined.delete(id); };
}

/** Removes a contact: the pair on the server, then the marker in the private file. */
export async function removeContact(id) {
  await ctx.api().removeContact(id);
  setContacts(contacts().filter(x => x.id !== id));
}

// ---------- the sync round ----------

/** Brings the requests waiting for this user and the confirmations of the ones this user sent. */
export async function contactsRound() {
  const list = await ctx.api().listInvitations();
  // "My code" shows a new code once its invitation is used or gone.
  if (code) code.then(inv => { if (!list.some(i => i.id === inv.id && !i.request)) code = null; }, () => {});
  await setRequests(list);
  if (contacts().some(x => x.pending)) await dropConfirmed();
}

async function setRequests(list) {
  const requests = [];
  let devices = null;
  for (const inv of list) {
    if (!inv.request || !inv.request.card || declined.has(inv.id)) continue;
    const key = `${inv.id}:${inv.request.identity}`;
    if (!checked.has(key)) {
      devices ||= (await ctx.chain()).devices;
      checked.set(key, await verify(inv, devices));
    }
    if (checked.get(key)) requests.push(checked.get(key));
  }
  if (JSON.stringify(requests) !== JSON.stringify(state.sync.requests)) setSync({ requests });
}

// The request of an invitation, or null when it doesn't add up: the invitation was signed by a device on
// this user's verified list, the card opens with this device's key, its secret hashes to the invitation ID
// and it is from the identity the server reports. The server can't forge a request, and only someone who
// had the code or link can send one.
async function verify(inv, devices) {
  const signer = devices.get(inv.device);
  if (!signer || !signer.active || !await c.verifyInvitation(signer.sign, inv.sig, inv.id)) return null;
  try {
    const card = parseContactCard(await c.openContactCard(inv.request.card, ctx.keys()));
    if (!card || card.identity !== inv.request.identity || card.identity === state.sync.identity) return null;
    if (await c.invitationId(c.fromB64u(card.secret, 16)) !== inv.id) return null;
    return { id: inv.id, identity: card.identity, name: card.name || "New contact", via: inv.kind === "link" ? "link" : "scan", inPerson: codes.has(inv.id) };
  } catch {
    return null;
  }
}

// A pending contact the server lists has been confirmed.
async function dropConfirmed() {
  const listed = new Set(await ctx.api().listContacts());
  const done = contacts().filter(x => x.pending && listed.has(x.id));
  if (!done.length) return;
  setContacts(contacts().map(x => {
    if (!x.pending || !listed.has(x.id)) return x;
    const { pending, ...confirmed } = x;
    return confirmed;
  }));
  for (const contact of done) confirmedListeners.forEach(fn => fn(contact));
}

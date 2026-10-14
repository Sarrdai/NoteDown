// How contacts and circles look: names, stable colors (`--person-N` tokens)
// and the small avatars used by the share dialog and the shared markers.
import { state } from "../store.js";
import { circleLabel, colorIndex, initials, visibleMembers } from "../core/sharing.js";

const contact = id => state.sync.contacts.find(c => c.id === id);

/** A contact's name; the raw id when the contact was removed. */
export const nameOf = id => contact(id)?.name ?? id;

/** "Lea & Tom" */
export const membersLabel = members => circleLabel(members.map(nameOf));

/** CSS color of a contact (a hash of the id for contacts without a stored color). */
export const personColor = id => `var(--person-${contact(id)?.color ?? colorIndex(id)})`;

const esc = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** One initials circle, HTML. `cls` adds modifiers such as "small". */
export function avatarHtml(id, cls = "") {
  return `<span class="avatar person ${cls}" style="--c:${personColor(id)}" aria-hidden="true">${esc(initials(nameOf(id)))}</span>`;
}

/** The avatar of someone asking to become a contact (no contact yet: color from the request id). */
export function requestAvatarHtml(r, cls = "") {
  return `<span class="avatar person ${cls}" style="--c:var(--person-${colorIndex(r.id)})" aria-hidden="true">${esc(initials(r.name))}</span>`;
}

/** How a contact request came in. */
export const requestHow = r => r.via === "link" ? "Opened your invitation link" : "Scanned your code";

/** Overlapping avatars of a circle (max 3 and "+N"), HTML. */
export function avatarStackHtml(members) {
  const { shown, more } = visibleMembers(members);
  return `<span class="avatar-stack" aria-hidden="true">${shown.map(id => avatarHtml(id, "small")).join("")}` +
    (more ? `<span class="avatar small more">+${more}</span>` : "") + `</span>`;
}

export { esc };

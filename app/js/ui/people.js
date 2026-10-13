// How contacts and circles look: names, stable colors (`--person-N` tokens)
// and the small avatars used by the share dialog and the shared markers.
import { state } from "../store.js";
import { circleLabel, circleKey, colorIndex, initials, visibleMembers } from "../core/sharing.js";

const contact = id => state.sync.contacts.find(c => c.id === id);

/** A contact's name; the raw id when the contact was removed. */
export const nameOf = id => contact(id)?.name ?? id;

/** "Lea & Tom" */
export const membersLabel = members => circleLabel(members.map(nameOf));

/** CSS color of a contact. */
export const personColor = id => `var(--person-${contact(id)?.color ?? colorIndex(id)})`;

/** CSS color of a circle: a single person keeps their own color. */
export const circleColor = members => members.length === 1 ? personColor(members[0]) : `var(--person-${colorIndex(circleKey(members))})`;

const esc = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** One initials circle, HTML. `cls` adds modifiers such as "small". */
export function avatarHtml(id, cls = "") {
  return `<span class="avatar person ${cls}" style="--c:${personColor(id)}" aria-hidden="true">${esc(initials(nameOf(id)))}</span>`;
}

/** Overlapping avatars of a circle (max 3 and "+N"), HTML. */
export function avatarStackHtml(members) {
  const { shown, more } = visibleMembers(members);
  return `<span class="avatar-stack" aria-hidden="true">${shown.map(id => avatarHtml(id, "small")).join("")}` +
    (more ? `<span class="avatar small more">+${more}</span>` : "") + `</span>`;
}

export { esc };

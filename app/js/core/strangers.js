// Shared files from people who aren't contacts (docs/security-review.md → L1): a shared file this device sees for
// the first time, in which no member other than the user is a contact, is held back — its notes show nowhere —
// until the user accepts it. The acceptance is a marker of the private file (docs/file-format.md → "Accepted
// shared files"). Pure rules; the store and the views apply them.
import { circleKey } from "./sharing.js";

export const NOT_A_CONTACT = " (not a contact)";

/**
 * The name shown for a member: the user's own name for a contact, else the name the member wrote into the
 * file ("Unknown" without one) with " (not a contact)". Someone who deleted their sync data has " (deleted)"
 * instead of that suffix (backlog #34).
 */
export function memberLabel({ contactName, fileName, deleted }) {
  if (contactName != null) return contactName + (deleted ? " (deleted)" : "");
  return (fileName ?? "Unknown") + (deleted ? " (deleted)" : NOT_A_CONTACT);
}

/**
 * Whether a shared file is held back: it has members (`members`: the ids other than the user), none of them is
 * in `contactIds` and its circleKey isn't in `accepted` ([{ id: circleKey, at }], the private file's markers).
 */
export function isHeld(members, contactIds, accepted) {
  if (!members.length) return false;
  if (members.some(m => contactIds.includes(m))) return false;
  const key = circleKey(members);
  return !accepted.some(a => a.id === key);
}

/**
 * The files that need an accepted marker although they aren't held: shared files with a contact among their
 * members that have none yet. Recording them when they arrive keeps them as they are if the user removes that
 * contact later. → circleKeys
 */
export function unrecordedKeys(circles, contactIds, accepted) {
  return circles
    .filter(m => m.some(id => contactIds.includes(id)) && !accepted.some(a => a.id === circleKey(m)))
    .map(circleKey);
}

/** `accepted` with these circleKeys added (time `at`); ones already there stay. */
export function withAccepted(accepted, keys, at) {
  const add = [...new Set(keys)].filter(k => !accepted.some(a => a.id === k));
  return add.length ? [...accepted, ...add.map(id => ({ id, at }))] : accepted;
}

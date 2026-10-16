// The list filters with several entries picked at once: circles from the
// People tab, labels from the Labels tab. Entries of one kind add notes
// (a note matches any picked circle and any picked label); circles and
// labels narrow each other. Nothing picked shows everything.
import { labelKey, labelsOf } from "./labels.js";

/** The picked circle keys after a tap on `key`: null clears, `exclusive`
 *  (the news, which mix with nothing) stands alone, any other key toggles
 *  and drops an exclusive one. */
export function toggleCircle(keys, key, exclusive) {
  if (key === null) return [];
  if (key === exclusive) return keys.includes(key) ? [] : [key];
  const rest = keys.filter(k => k !== exclusive);
  return rest.includes(key) ? rest.filter(k => k !== key) : [...rest, key];
}

/** The picked labels after a tap on `name` (case-insensitive); null clears. */
export function toggleLabel(names, name) {
  if (name === null) return [];
  const rest = names.filter(n => labelKey(n) !== labelKey(name));
  return rest.length < names.length ? rest : [...names, name];
}

/** Whether a body carries one of the labels (true when none are picked). */
export function hasAnyLabel(body, names) {
  if (!names.length) return true;
  const keys = new Set(names.map(labelKey));
  return labelsOf(body).some(l => keys.has(labelKey(l)));
}

// The tidy-up reminder: how full the pile of "My order" is (the notes not
// sorted into the order yet). Each circle (circleKey, "" = private) has its
// own choice — off or a threshold of notes or days — private on by default,
// shared circles off (decided 2026-10-18: shared notes are often sorted by
// someone else). The pile's level is the highest of its circles' levels.

/** The thresholds: a pile is due for tidying from `notes` notes or once its oldest is `days` old. */
export const TIDY_PRESETS = {
  often: { notes: 5, days: 3 },
  normal: { notes: 10, days: 7 },
  rarely: { notes: 20, days: 28 },
};

/** The choices in the settings, off first. */
export const TIDY_CHOICES = ["off", "often", "normal", "rarely"];

/** The levels from low to high; null = no reminder. */
export const TIDY_LEVELS = ["calm", "growing", "tidy"];

/** A circle's choice: its own from `settings` (circleKey → choice), else private "normal", shared "off". */
export function tidyChoice(settings, key) {
  const own = settings?.[key];
  if (TIDY_CHOICES.includes(own)) return own;
  return key === "" ? "normal" : "off";
}

/** The level of one circle's pile notes: "tidy" at the threshold, "growing" from half of it, else "calm". */
export function circleLevel(count, ageDays, preset) {
  if (count >= preset.notes || ageDays >= preset.days) return "tidy";
  if (count >= Math.ceil(preset.notes / 2) || ageDays >= preset.days / 2) return "growing";
  return "calm";
}

/**
 * The pile's state: `pile` are its notes as { created (ISO time), circle (circleKey) },
 * `choiceOf(circle)` gives a circle's choice, `now` is in ms. Returns `level` (null when
 * no circle of the pile has a reminder on), `count` (all notes) and `oldest` (the oldest
 * creation time among the notes with a reminder, or null).
 */
export function pileState(pile, choiceOf, now = Date.now()) {
  const byCircle = new Map();
  for (const n of pile) {
    const preset = TIDY_PRESETS[choiceOf(n.circle)];
    if (!preset) continue;
    if (!byCircle.has(n.circle)) byCircle.set(n.circle, { preset, count: 0, oldest: null });
    const c = byCircle.get(n.circle);
    c.count++;
    if (!c.oldest || n.created < c.oldest) c.oldest = n.created;
  }
  let level = null, oldest = null;
  for (const c of byCircle.values()) {
    const age = (now - Date.parse(c.oldest)) / 86400000;
    const l = circleLevel(c.count, age, c.preset);
    if (TIDY_LEVELS.indexOf(l) > TIDY_LEVELS.indexOf(level)) level = l;
    if (!oldest || c.oldest < oldest) oldest = c.oldest;
  }
  return { level, count: pile.length, oldest };
}

// The tidy-up reminder: how full the pile of "My order" is (the notes not
// sorted into the order yet), as a gauge of bars. One bar fills per `notes`
// notes on the pile and one per `days` days its oldest note has waited, up to
// `bars` (decided 2026-10-18: both pressures add up, half bars don't count).
// The three numbers hold for every circle; a circle (circleKey, "" = private)
// is counted or ignored — private counted by default, shared circles ignored
// (shared notes are often sorted by someone else).

/** The numbers at first, and the range the settings allow. */
export const TIDY_DEFAULTS = { bars: 5, notes: 2, days: 2 };
export const TIDY_LIMITS = { bars: [1, 10], notes: [1, 20], days: [1, 30] };

/** The gauge's numbers from the settings (`settings.tidy`), whole and within the limits. */
export function tidyConfig(settings) {
  const cfg = {};
  for (const [k, [min, max]] of Object.entries(TIDY_LIMITS)) {
    const v = Math.round(Number(settings?.[k]));
    cfg[k] = Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : TIDY_DEFAULTS[k];
  }
  return cfg;
}

/** Whether a circle's pile notes count: its own choice in `settings.circles`, else private yes, shared no.
 *  (Before 2026-10-18 a circle's entry was a preset name directly in `settings`; "off" meant ignored.) */
export function tidyCounted(settings, key) {
  const own = settings?.circles?.[key];
  if (typeof own === "boolean") return own;
  const legacy = settings?.[key];
  if (typeof legacy === "string") return legacy !== "off";
  return key === "";
}

/** Filled bars for `count` notes whose oldest waited `ageDays`: whole steps of each, added, at most `cfg.bars`. */
export function filledBars(count, ageDays, cfg) {
  return Math.min(cfg.bars, Math.floor(count / cfg.notes) + Math.floor(Math.max(0, ageDays) / cfg.days));
}

/** The gauge's colour: "full" (red) at all bars, "warn" (yellow) from 75 % but at the latest one bar
 *  before full, else "calm". */
export function tidyLevel(filled, bars) {
  if (filled >= bars) return "full";
  if (bars > 1 && filled >= Math.min(Math.ceil(bars * 0.75), bars - 1)) return "warn";
  return "calm";
}

/**
 * The pile's state: `pile` are its notes as { created (ISO time), circle (circleKey) },
 * `counted(circle)` says whether a circle counts, `cfg` from tidyConfig, `now` in ms.
 * The counted notes are taken together. Returns `count` (all notes), `bars`, `filled`
 * and `level` — `level` null (no gauge) when none of the notes counts.
 */
export function pileState(pile, counted, cfg, now = Date.now()) {
  let n = 0, oldest = null;
  for (const note of pile) {
    if (!counted(note.circle)) continue;
    n++;
    if (!oldest || note.created < oldest) oldest = note.created;
  }
  if (!n) return { count: pile.length, bars: cfg.bars, filled: 0, level: null };
  const filled = filledBars(n, (now - Date.parse(oldest)) / 86400000, cfg);
  return { count: pile.length, bars: cfg.bars, filled, level: tidyLevel(filled, cfg.bars) };
}

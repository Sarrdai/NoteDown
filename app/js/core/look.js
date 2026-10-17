// A note's look: a background color from a fixed palette and a built-in
// motif (docs/requirements.md → "Note colors and motifs"). Both are marker
// attributes (`color=`, `decor=`), so they sync with the note and everyone it
// is shared with sees them. The names are plain words, not theme names: each
// flavor maps them to its own shade (app.css), so the text stays readable.

export const COLORS = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"];
export const DECORS = ["dots", "grid", "waves", "leaves", "stars"];

export const COLOR_NAMES = { red: "Red", orange: "Orange", yellow: "Yellow", green: "Green", teal: "Teal", blue: "Blue", purple: "Purple", pink: "Pink" };
export const DECOR_NAMES = { dots: "Dots", grid: "Grid", waves: "Waves", leaves: "Leaves", stars: "Stars" };

/** A known color or null (unknown values from newer apps read as none). */
export const validColor = c => (COLORS.includes(c) ? c : null);
/** A known motif or null. */
export const validDecor = d => (DECORS.includes(d) ? d : null);

/** The look several notes share: { color, decor }, each null when none or when they differ (`mixed` says which differ). */
export function commonLook(notes) {
  const one = key => {
    const values = new Set(notes.map(n => n[key] || null));
    return values.size === 1 ? [...values][0] : undefined;
  };
  const color = one("color"), decor = one("decor");
  return { color: color ?? null, decor: decor ?? null, mixed: { color: color === undefined, decor: decor === undefined } };
}

// Google Keep's note colors (Takeout's "color") in this palette; the others have no match.
const KEEP = { RED: "red", ORANGE: "orange", YELLOW: "yellow", GREEN: "green", TEAL: "teal", BLUE: "blue", CERULEAN: "blue", PURPLE: "purple", PINK: "pink" };
export const keepColor = c => KEEP[c] || null;

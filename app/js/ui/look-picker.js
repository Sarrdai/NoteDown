// The color and motif picker (docs/requirements.md → "Note colors and
// motifs"): a popup with a row of colors and a row of motifs. A tap applies
// at once and the popup stays open, so the user can try a few; a tap outside
// or Esc closes it. "None" clears the color or the motif.
import { COLORS, DECORS, COLOR_NAMES, DECOR_NAMES, commonLook } from "../core/look.js";
import { note, setLook } from "../store.js";
import { openMenu } from "./menu.js";
import { icon } from "./icons.js";

/** Opens the picker at `anchor` for the notes `ids`. */
export function openLookPicker(anchor, ids) {
  const colors = row("look-colors", [null, ...COLORS], c => swatch("color", c, c ? COLOR_NAMES[c] : "No color"));
  const decors = row("look-decors", [null, ...DECORS], d => swatch("decor", d, d ? DECOR_NAMES[d] : "No motif"));
  const mark = () => {
    const look = commonLook(ids.map(note).filter(Boolean));
    for (const b of [...colors.children, ...decors.children]) {
      const key = b.dataset.key, value = b.dataset.value || null;
      b.setAttribute("aria-checked", String(!look.mixed[key] && look[key] === value));
    }
    // The motif previews show the chosen color.
    decors.dataset.color = look.mixed.color ? "" : look.color || "";
  };
  for (const r of [colors, decors]) r.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    e.stopPropagation();
    setLook(ids, { [b.dataset.key]: b.dataset.value || null });
    mark();
  });
  mark();
  openMenu(anchor, [{ section: "Color" }, { node: colors }, { section: "Motif" }, { node: decors }]);
}

function row(cls, values, make) {
  const el = document.createElement("div");
  el.className = "look-row " + cls;
  el.setAttribute("role", "radiogroup");
  el.append(...values.map(make));
  return el;
}

function swatch(key, value, label) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "look-swatch";
  b.dataset.key = key;
  b.dataset.value = value || "";
  if (key === "color" && value) b.dataset.color = value;
  if (key === "decor" && value) b.dataset.decor = value;
  b.setAttribute("role", "radio");
  b.setAttribute("aria-label", label);
  b.title = label;
  b.innerHTML = value ? icon("check", "icon check") : icon("none", "icon none") + icon("check", "icon check");
  // No focus change: opened from the editing toolbar it keeps the keyboard up.
  b.addEventListener("pointerdown", e => e.preventDefault());
  return b;
}

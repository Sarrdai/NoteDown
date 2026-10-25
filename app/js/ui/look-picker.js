// The color, motif and texture picker (docs/requirements.md → "Note colors
// and motifs"): a popup with rows of swatches. A tap applies at once and the
// popup stays open, so the user can try a few; a tap outside or Esc closes it.
// "None" clears the color, the motif or the texture.
// Prototype: the texture is offered in its own row (A, "row") or as a second
// row of textured colors (B, "colors"), settings.texturePicker.
import { COLORS, DECORS, COLOR_NAMES, DECOR_NAMES, commonLook } from "../core/look.js";
import { note, setLook, state } from "../store.js";
import { openMenu } from "./menu.js";
import { icon } from "./icons.js";

/** Opens the picker at `anchor` for the notes `ids`. */
export function openLookPicker(anchor, ids) {
  const byColors = state.settings.texturePicker === "colors";
  const colors = row("look-colors", [null, ...COLORS], c => swatch(byColors ? { color: c, texture: null } : { color: c }, c ? COLOR_NAMES[c] : "No color"));
  const grainy = byColors && row("look-colors", [null, ...COLORS], c => swatch({ color: c, texture: "grain" }, (c ? COLOR_NAMES[c] : "No color") + " with grain"));
  const textures = !byColors && row("look-textures", [null, "grain"], t => swatch({ texture: t }, t ? "Grain" : "No texture"));
  const decors = row("look-decors", [null, ...DECORS], d => swatch({ decor: d }, d ? DECOR_NAMES[d] : "No motif"));
  const rows = [colors, grainy, textures, decors].filter(Boolean);
  const mark = () => {
    const look = commonLook(ids.map(note).filter(Boolean));
    for (const b of rows.flatMap(r => [...r.children])) {
      b.setAttribute("aria-checked", String(Object.entries(b.look).every(([k, v]) => !look.mixed[k] && look[k] === v)));
    }
    // The motif and texture previews show the chosen color.
    const color = look.mixed.color ? "" : look.color || "";
    decors.dataset.color = color;
    if (textures) for (const b of textures.children) { if (color) b.dataset.color = color; else delete b.dataset.color; }
  };
  for (const r of rows) r.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    e.stopPropagation();
    setLook(ids, b.look);
    mark();
  });
  mark();
  openMenu(anchor, [
    { section: "Color" }, { node: colors },
    ...(grainy ? [{ node: grainy }] : [{ section: "Texture" }, { node: textures }]),
    { section: "Motif" }, { node: decors },
  ]);
}

function row(cls, values, make) {
  const el = document.createElement("div");
  el.className = "look-row " + cls;
  el.setAttribute("role", "radiogroup");
  el.append(...values.map(make));
  return el;
}

// A swatch sets `look` ({ color?, decor?, texture? }) on tap; it shows what it sets.
function swatch(look, label) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "look-swatch";
  b.look = look;
  if (look.color) b.dataset.color = look.color;
  if (look.decor) b.dataset.decor = look.decor;
  if (look.texture) b.dataset.texture = look.texture;
  const none = !look.color && !look.decor && !look.texture;
  b.setAttribute("role", "radio");
  b.setAttribute("aria-label", label);
  b.title = label;
  b.innerHTML = none ? icon("none", "icon none") + icon("check", "icon check") : icon("check", "icon check");
  // No focus change: opened from the editing toolbar it keeps the keyboard up.
  b.addEventListener("pointerdown", e => e.preventDefault());
  return b;
}

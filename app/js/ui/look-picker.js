// The color, motif and texture picker (docs/requirements.md → "Note colors
// and motifs"): a popup with a row of colors, a grain slider and a row of
// motifs. A tap or a slide applies at once and the popup stays open, so the
// user can try a few; a tap outside or Esc closes it. "None" clears the color
// or the motif, the slider at its left end the grain.
import { COLORS, DECORS, COLOR_NAMES, DECOR_NAMES, commonLook, grainStrength, grainTexture } from "../core/look.js";
import { note, setLook } from "../store.js";
import { openMenu } from "./menu.js";
import { icon } from "./icons.js";

/** Opens the picker at `anchor` for the notes `ids`. */
export function openLookPicker(anchor, ids) {
  const colors = row("look-colors", [null, ...COLORS], c => swatch("color", c, c ? COLOR_NAMES[c] : "No color"));
  const decors = row("look-decors", [null, ...DECORS], d => swatch("decor", d, d ? DECOR_NAMES[d] : "No motif"));
  const grain = slider();
  const mark = () => {
    const look = commonLook(ids.map(note).filter(Boolean));
    for (const b of [...colors.children, ...decors.children]) {
      const key = b.dataset.key, value = b.dataset.value || null;
      b.setAttribute("aria-checked", String(!look.mixed[key] && look[key] === value));
    }
    // The motif previews show the chosen color.
    decors.dataset.color = look.mixed.color ? "" : look.color || "";
    // Notes with different grain start the slider at none.
    if (document.activeElement !== grain.input) grain.set(look.mixed.texture ? 0 : grainStrength(look.texture));
  };
  for (const r of [colors, decors]) r.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    e.stopPropagation();
    setLook(ids, { [b.dataset.key]: b.dataset.value || null });
    mark();
  });
  grain.input.addEventListener("input", () => {
    grain.set(+grain.input.value);
    setLook(ids, { texture: grainTexture(+grain.input.value) });
  });
  mark();
  openMenu(anchor, [{ section: "Color" }, { node: colors }, { section: "Grain" }, { node: grain.el }, { section: "Motif" }, { node: decors }]);
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
  return b;
}

// The grain strength, 0 (none) to 100, with its value beside it.
function slider() {
  const el = document.createElement("div");
  el.className = "look-grain";
  const input = Object.assign(document.createElement("input"), { type: "range", min: 0, max: 100, step: 5 });
  input.setAttribute("aria-label", "Grain strength");
  const out = document.createElement("span");
  out.className = "look-grain-value";
  el.append(input, out);
  // A click on the slider stays in the popup.
  el.addEventListener("click", e => e.stopPropagation());
  const set = v => { input.value = v; out.textContent = v ? v + " %" : "None"; };
  return { el, input, set };
}

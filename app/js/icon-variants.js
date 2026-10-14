// Prototype only: the app icon proposals (backlog #12, ⋮ → "Prototype: App icon").
// Sets the favicon to the chosen proposal and shows it the way a launcher and
// the Android splash screen would. Deleted once the icon is decided.
export const ICONS = { a: "Note card", b: "N with arrow", c: "Done button" };

const src = id => new URL(`../icons/icon-${id}.svg`, import.meta.url).href;
const MASKS = ["circle", "squircle", "rounded"];
let shown = null;

export function applyIcon(id) {
  if (shown === id) return;
  shown = id;
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = Object.assign(document.createElement("link"), { rel: "icon", type: "image/svg+xml" });
    document.head.append(link);
  }
  // The visible part of the 108-unit grid is the central 72 units; round it like a launcher would.
  fetch(src(id)).then(r => r.text()).then(svg => {
    if (shown !== id) return;
    svg = svg.replace('viewBox="0 0 108 108"', 'viewBox="18 18 72 72"')
      .replace('<rect id="background" width="108" height="108"', '<rect id="background" x="18" y="18" width="72" height="72" rx="20"');
    link.href = "data:image/svg+xml," + encodeURIComponent(svg);
  });
}

function tile(id, mask, size, label = "") {
  // Launchers and the splash screen show the central 72 of the 108 units, under a mask.
  return `<figure class="ip-tile"><span class="ip-icon ${mask}" style="width:${size}px;height:${size}px">`
    + `<img src="${src(id)}" width="${size * 1.5}" height="${size * 1.5}" alt=""></span>`
    + (label ? `<figcaption>${label}</figcaption>` : "") + "</figure>";
}

// One launcher row: the three common masks at 48 px with a label, plus larger sizes.
function launcher(id, flavor) {
  return `<div class="ip-wall" data-flavor="${flavor}">`
    + MASKS.map(m => tile(id, m, 48, "NoteDown")).join("")
    + tile(id, "squircle", 72) + tile(id, "squircle", 96) + "</div>";
}

// Android 12+ splash: the icon in a circle on the flavor's base color.
function splash(id, flavor) {
  return `<div class="ip-splash" data-flavor="${flavor}">${tile(id, "circle", 64)}</div>`;
}

export function openIconPreview(id) {
  const scrim = document.createElement("div");
  scrim.className = "dialog-scrim";
  scrim.innerHTML = `<div class="dialog icon-preview" role="dialog" aria-modal="true" aria-labelledby="ipTitle">
    <h2 class="dialog-title" id="ipTitle">App icon: ${ICONS[id]} (${id.toUpperCase()})</h2>
    <p class="dialog-hint">Launcher masks and sizes on a light and a dark wallpaper, then the splash screen in Latte and Mocha.</p>
    <div class="ip-body">${launcher(id, "latte")}${launcher(id, "mocha")}
      <div class="ip-splashes">${splash(id, "latte")}${splash(id, "mocha")}</div></div>
    <div class="dialog-actions"><button class="btn" id="ipClose">Close</button></div></div>`;
  const close = () => scrim.remove();
  scrim.addEventListener("click", e => { if (e.target === scrim || e.target.id === "ipClose") close(); });
  document.body.append(scrim);
  scrim.querySelector("#ipClose").focus({ preventScroll: true });
}

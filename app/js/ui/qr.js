// Prototype only: a fake QR code and a fake camera view. Nothing is
// encoded and no camera is opened; both just stand in for the real ones.
import { qrMatrix, QR_SIZE } from "../core/sharing.js";
import { icon } from "./icons.js";

const QUIET = 2;   // modules of empty border around the code

/** A QR-looking code for `seed` (same seed, same picture) with a caption. */
export function qrFigure(seed, label = "Prototype QR code") {
  const grid = qrMatrix(seed);
  let d = "";
  grid.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x + QUIET} ${y + QUIET}h1v1h-1z`; }));
  const size = QR_SIZE + 2 * QUIET;
  const fig = document.createElement("figure");
  fig.className = "qr";
  fig.innerHTML = `<svg viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="${label}">` +
    `<rect class="qr-bg" width="${size}" height="${size}" rx="1.5"/><path class="qr-fg" d="${d}"/></svg>` +
    `<figcaption>Prototype — not scannable</figcaption>`;
  return fig;
}

/** The camera view of a scanner page: a dark square with accent corner marks. */
export function scannerView(hint) {
  const wrap = document.createElement("div");
  wrap.className = "scanner-wrap";
  wrap.innerHTML = `<div class="scanner" role="img" aria-label="Camera view (prototype)">` +
    `<span class="corner tl"></span><span class="corner tr"></span><span class="corner bl"></span><span class="corner br"></span>` +
    icon("qr", "icon scanner-icon") + `</div><p class="scanner-hint"></p>`;
  wrap.querySelector(".scanner-hint").textContent = hint;
  return wrap;
}

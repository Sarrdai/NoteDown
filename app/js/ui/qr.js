// QR codes and the camera scanner of the "Sync & sharing" panel. The code is
// drawn by the vendored qrcode-generator, the camera is read with
// getUserMedia (in the Android app too) and decoded by the vendored jsQR,
// which is loaded only when a scanner opens. The sample keeps a still camera
// view (`scannerView`) with "Simulate scan" instead.
import qrcode from "../../vendor/qrcode.esm.js";
import { icon } from "./icons.js";

const QUIET = 4;          // modules of empty border, as the QR standard asks
const SCAN_MS = 150;      // pause between two decoded frames
const SCAN_WIDTH = 640;   // frames are scaled down to this width for decoding

/** The QR code of `text` (error correction M) as an SVG figure. */
export function qrFigure(text, label = "QR code") {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  const n = code.getModuleCount();
  let d = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (code.isDark(y, x)) d += `M${x + QUIET} ${y + QUIET}h1v1h-1z`;
  const size = n + 2 * QUIET;
  const fig = document.createElement("figure");
  fig.className = "qr";
  fig.innerHTML = `<svg viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img">` +
    `<rect class="qr-bg" width="${size}" height="${size}" rx="2"/><path class="qr-fg" d="${d}"/></svg>`;
  fig.querySelector("svg").setAttribute("aria-label", label);
  fig.dataset.code = text;
  return fig;
}

/** A still camera view with corner marks and a hint below (the sample's scanner). */
export function scannerView(hint) {
  const wrap = document.createElement("div");
  wrap.className = "scanner-wrap";
  wrap.innerHTML = `<div class="scanner" role="img" aria-label="Camera view">` +
    `<span class="corner tl"></span><span class="corner tr"></span><span class="corner bl"></span><span class="corner br"></span>` +
    icon("qr", "icon scanner-icon") + `</div><p class="scanner-hint" role="status"></p>`;
  wrap.querySelector(".scanner-hint").textContent = hint;
  return wrap;
}

/**
 * The live scanner: the back camera in the camera view, each frame decoded
 * until `onCode(text)` accepts a code (returns true); a code it refuses shows
 * `wrongCode` as the hint. Returns { el, stop }; `stop` turns the camera off.
 */
export function cameraScanner({ hint, wrongCode, noCamera, onCode }) {
  const el = scannerView(hint);
  const box = el.querySelector(".scanner");
  const hintEl = el.querySelector(".scanner-hint");
  const video = document.createElement("video");
  video.className = "scanner-video";
  video.muted = true;
  video.playsInline = true;
  box.prepend(video);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let stream = null, stopped = false, timer = null, decode = null;

  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    if (stream) stream.getTracks().forEach(t => t.stop());
  };
  const fail = text => { box.classList.add("off"); hintEl.textContent = text; };

  function tick() {
    if (stopped) return;
    const w = video.videoWidth, h = video.videoHeight;
    if (w && h) {
      const scale = Math.min(1, SCAN_WIDTH / w);
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const found = decode(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: "attemptBoth" });
      if (found && found.data) {
        if (onCode(found.data)) return stop();
        hintEl.textContent = wrongCode;
      }
    }
    timer = setTimeout(tick, SCAN_MS);
  }

  (async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return fail(noCamera);
    try {
      [stream, { default: decode }] = await Promise.all([
        navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false }),
        import("../../vendor/jsqr.esm.js"),
      ]);
    } catch (e) {
      return fail(e.name === "NotAllowedError" ? "Camera access is blocked. Allow it in the settings and open this page again." : noCamera);
    }
    if (stopped) return stop();
    video.srcObject = stream;
    box.classList.add("live");
    await video.play().catch(() => {});
    tick();
  })();
  return { el, stop };
}

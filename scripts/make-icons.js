#!/usr/bin/env node
// Renders the app icon (app/icons/icon.svg) into the files the web app and
// the Android app need. Run it once after changing the icon and commit the
// output; nothing runs it at build time.
//
//   NODE_PATH="$(npm root -g)" node scripts/make-icons.js
//
// icon.svg uses the Android adaptive-icon grid: 108 units, of which a
// launcher shows the central 72 under its mask; the glyph (#foreground) stays
// inside the central 66-unit circle. Needs Playwright (preinstalled in the
// cloud container).
"use strict";
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "app/icons");
const RES = path.join(ROOT, "mobile/android/app/src/main/res");
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

const source = fs.readFileSync(path.join(WEB, "icon.svg"), "utf8");
const background = /<rect id="background"[^>]*fill="([^"]+)"/.exec(source)[1];
const foreground = /<g id="foreground"[\s\S]*?<\/g>/.exec(source)[0];
const svg = (viewBox, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`;
const VISIBLE = "18 18 72 72";

const SHAPES = {
  // The visible 72 units with rounded corners: favicon, web "any" icons, legacy launcher icon.
  rounded: svg(VISIBLE, `<rect x="18" y="18" width="72" height="72" rx="16" fill="${background}"/>${foreground}`),
  round: svg(VISIBLE, `<circle cx="54" cy="54" r="36" fill="${background}"/>${foreground}`),
  // Square, uncropped corners: iOS rounds the apple-touch-icon itself.
  square: svg(VISIBLE, `<rect width="108" height="108" fill="${background}"/>${foreground}`),
  // The whole grid: web "maskable" icon (safe zone = central 80 %).
  full: source,
  // Adaptive-icon layers: the glyph alone, and a one-color version for themed icons
  // (light parts of the glyph stay, everything else is cut out).
  foreground: svg("0 0 108 108", foreground),
  monochrome: svg("0 0 108 108", silhouette("0 0 108 108")),
  // Android status-bar icon for reminders (white on transparent, tinted by the system):
  // the same silhouette, cropped to the glyph.
  notification: svg("27 27 54 54", silhouette("27 27 54 54")),
};

// One-color version of the glyph: light parts stay white, everything else is cut out.
function silhouette(viewBox) {
  const [x, y, w, h] = viewBox.split(" ");
  return `<mask id="m">${foreground
    .replace(/(fill|stroke)="(?!none)([^"]+)"/g, (_, attr, color) => `${attr}="${color === "#eff1f5" ? "#fff" : "#000"}"`)
    .replace(/ opacity="[^"]+"/g, "")}</mask><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fff" mask="url(#m)"/>`;
}

const OUTPUTS = [
  ["favicon.svg", "rounded"],
  ["icon-192.png", "rounded", 192],
  ["icon-512.png", "rounded", 512],
  ["icon-maskable-512.png", "full", 512],
  ["apple-touch-icon.png", "square", 180],
].map(([file, shape, size]) => ({ file: path.join(WEB, file), shape, size }));
for (const [density, scale] of Object.entries(DENSITIES)) {
  const dir = path.join(RES, `mipmap-${density}`);
  OUTPUTS.push(
    { file: path.join(dir, "ic_launcher.png"), shape: "rounded", size: 48 * scale },
    { file: path.join(dir, "ic_launcher_round.png"), shape: "round", size: 48 * scale },
    { file: path.join(dir, "ic_launcher_foreground.png"), shape: "foreground", size: 108 * scale },
    { file: path.join(dir, "ic_launcher_monochrome.png"), shape: "monochrome", size: 108 * scale },
    { file: path.join(RES, `drawable-${density}`, "ic_stat_notedown.png"), shape: "notification", size: 24 * scale },
  );
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const { file, shape, size } of OUTPUTS) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!size) { fs.writeFileSync(file, SHAPES[shape] + "\n"); console.log(path.relative(ROOT, file)); continue; }
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html, body { margin: 0; background: transparent; }</style>
      <img width="${size}" height="${size}" src="data:image/svg+xml,${encodeURIComponent(SHAPES[shape])}">`);
    await page.waitForFunction(() => document.images[0].complete);
    fs.writeFileSync(file, await page.screenshot({ omitBackground: true }));
    console.log(path.relative(ROOT, file));
  }
  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });

#!/usr/bin/env node
// Opens one mockup page in headless Chromium in a device tier and takes a
// screenshot — for verifying a mockup against its decision and for README
// pictures (PROJECT.md → "Device tiers").
//
//   node scripts/screenshot.js <mockups/page.html> [--device desktop|tablet|phone]
//        [--out shot.png] [--theme light|dark] [--eval "<js run in the page before the shot>"]
//        [--wait <ms>] [--full]
//
// --device sets viewport and input: desktop = 1440x900 mouse, tablet =
// 820x1180 touch, phone = 390x844 touch. --theme sets prefers-color-scheme.
// --full captures the whole scrollable page. Page errors are listed after
// the shot, so a broken mockup is visible even when the picture looks fine.
//
// Needs Playwright (preinstalled globally in the cloud container: run with
// NODE_PATH="$(npm root -g)").
"use strict";
const path = require("path");
const { chromium } = require("playwright");

const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  tablet: { viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
  phone: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 },
};

async function main() {
  const args = process.argv.slice(2);
  const opt = { device: "desktop", out: "shot.png", theme: "light", eval: null, wait: 300, full: false };
  let page = null;
  for (let i = 0; i < args.length; i++) {
    const m = /^--(device|out|theme|eval|wait)$/.exec(args[i]);
    if (m) opt[m[1]] = args[++i];
    else if (args[i] === "--full") opt.full = true;
    else page = path.resolve(args[i]);
  }
  if (!page) throw new Error("no page given");
  if (!DEVICES[opt.device]) throw new Error("unknown device: " + opt.device);

  const browser = await chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { executablePath: "/opt/pw-browsers/chromium" });
  const errors = [];
  try {
    const tab = await browser.newPage(Object.assign({ colorScheme: opt.theme }, DEVICES[opt.device]));
    tab.on("pageerror", e => errors.push(e.message));
    tab.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });
    await tab.goto("file://" + page);
    if (opt.eval) await tab.evaluate(opt.eval);
    await tab.waitForTimeout(+opt.wait);
    await tab.screenshot({ path: opt.out, fullPage: opt.full });
  } finally {
    await browser.close();
  }
  process.stderr.write("screenshot: " + opt.out + (errors.length ? "\npage errors:\n  " + errors.join("\n  ") : "") + "\n");
  if (errors.length) process.exitCode = 1;
}

main().catch(err => { process.stderr.write("screenshot: " + err.message + "\n"); process.exitCode = 1; });

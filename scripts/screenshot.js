#!/usr/bin/env node
// Opens the prototype (or another page of the repo) in headless Chromium in a
// device tier and takes a screenshot — for verifying a round against its
// decision and for README pictures (PROJECT.md → "Device tiers").
//
//   node scripts/screenshot.js [app/index.html] [--device desktop|tablet|phone]
//        [--out shot.png] [--theme light|dark] [--query "list=document&toc=sheet"]
//        [--eval "<js run in the page before the shot>"] [--wait <ms>] [--full]
//        [--first-start]
//
// The repo is served over a throwaway local HTTP server (ES modules don't
// load from file://). Each run starts with empty storage and adds `sample`
// to the query, so the app shows the sample notes; --first-start leaves it
// out and shows what a new user sees (the welcome notes). --device sets
// viewport and input: desktop = 1440x900 mouse, tablet = 820x1180 touch,
// phone = 390x844 touch. --theme sets
// prefers-color-scheme (the app's "System" theme follows it). --query is
// appended to the page URL (app options: PROJECT.md → "Prototype options").
// --eval may return a promise; the shot waits for it. Page errors are listed
// after the shot and make the exit code non-zero.
//
// Needs Playwright (preinstalled globally in the cloud container: run with
// NODE_PATH="$(npm root -g)").
"use strict";
const fs = require("fs");
const http = require("http");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  tablet: { viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
  phone: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 },
};
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".md": "text/markdown", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webm": "video/webm", ".json": "application/json", ".webmanifest": "application/manifest+json" };

function serve() {
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function main() {
  const args = process.argv.slice(2);
  const opt = { device: "desktop", out: "shot.png", theme: "light", query: "", eval: null, wait: 300, full: false, sample: true };
  let page = "app/index.html";
  for (let i = 0; i < args.length; i++) {
    const m = /^--(device|out|theme|query|eval|wait)$/.exec(args[i]);
    if (m) opt[m[1]] = args[++i];
    else if (args[i] === "--full") opt.full = true;
    else if (args[i] === "--first-start") opt.sample = false;
    else page = path.relative(ROOT, path.resolve(args[i]));
  }
  if (!DEVICES[opt.device]) throw new Error("unknown device: " + opt.device);

  const server = await serve();
  const browser = await chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { executablePath: "/opt/pw-browsers/chromium" });
  const errors = [];
  try {
    const tab = await browser.newPage(Object.assign({ colorScheme: opt.theme }, DEVICES[opt.device]));
    tab.on("pageerror", e => errors.push(e.message));
    tab.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });
    const url = `http://127.0.0.1:${server.address().port}/${page.split(path.sep).join("/")}` + "?" + [opt.sample && page.startsWith("app") ? "sample" : "", opt.query].filter(Boolean).join("&");
    await tab.goto(url);
    // The app marks itself ready once the notes are rendered.
    await tab.waitForFunction(() => document.body.dataset.ready === "1" || !document.querySelector("#app"), null, { timeout: 10000 }).catch(() => errors.push("app did not become ready"));
    if (opt.eval) await tab.evaluate(opt.eval);
    await tab.waitForTimeout(+opt.wait);
    await tab.screenshot({ path: opt.out, fullPage: opt.full });
  } finally {
    await browser.close();
    server.close();
  }
  process.stderr.write("screenshot: " + opt.out + (errors.length ? "\npage errors:\n  " + errors.join("\n  ") : "") + "\n");
  if (errors.length) process.exitCode = 1;
}

main().catch(err => { process.stderr.write("screenshot: " + err.message + "\n"); process.exitCode = 1; });

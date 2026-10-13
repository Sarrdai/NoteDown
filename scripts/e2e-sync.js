#!/usr/bin/env node
// End-to-end test of real sync, run by scripts/test-sync.sh against a local
// server on 127.0.0.1:8765. Browser contexts stand in for devices: A turns
// sync on, B joins with the recovery key, both edit (also the same note at
// once), A removes B, and C restores. Every step checks that the devices end
// up with the same file. Note texts come from app/sample/notes.md.
//
//   scripts/test-sync.sh [--shots <dir>]   (screenshots of the panel pages)
"use strict";
const fs = require("fs");
const http = require("http");
const path = require("path");
const assert = require("assert/strict");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const API = "http://127.0.0.1:8765";
const PORT = 8766;   // the origin the server allows (CORS_ORIGINS in test-sync.sh)
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".md": "text/markdown", ".json": "application/json", ".svg": "image/svg+xml" };
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;

// Bodies of the sample notes, by id.
const sample = Object.fromEntries(fs.readFileSync(path.join(ROOT, "app/sample/notes.md"), "utf8")
  .split(/^(?=<!-- note )/m).map(part => [/id=(\S+)/.exec(part)?.[1], part.replace(/^<!--.*-->\n/, "").trim()]));

function serve() {
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

const errors = [];

async function device(browser, name, viewport, api = true) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width < 600, isMobile: viewport.width < 600 });
  const page = await context.newPage();
  page.on("pageerror", e => errors.push(`${name}: ${e.message}`));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
  await page.goto(`http://127.0.0.1:${PORT}/app/index.html` + (api ? `?api=${API}` : ""));
  await page.waitForFunction(() => document.body.dataset.ready === "1");
  await page.evaluate(async () => {
    window.__store = await import("/app/js/store.js");
    window.__sync = await import("/app/js/sync/client.js");
  });
  page.label = name;
  return page;
}

const sync = page => page.evaluate(() => window.__sync.syncNow());
const fileText = page => page.evaluate(() => window.__store.fileText());
const syncState = page => page.evaluate(() => window.__store.state.sync);
const bodies = page => page.evaluate(() => window.__store.allNotes().map(n => n.body));
const addNote = (page, body) => page.evaluate(b => window.__store.addNote(b), body);

async function openPanel(page) {
  await page.click("#moreBtn");
  await page.locator(".menu-item", { hasText: "Sync & sharing" }).click();
}

async function shot(page, name) {
  if (shots) await page.screenshot({ path: path.join(shots, `sync-${name}.png`) });
}

async function converge(...pages) {
  for (const p of [...pages, ...pages]) await sync(p);
  const texts = await Promise.all(pages.map(fileText));
  if (new Set(texts).size > 1) for (const [i, t] of texts.entries()) console.log(`--- ${pages[i].label}\n${t}`);
  for (const [i, t] of texts.entries()) assert.equal(t, texts[0], `${pages[i].label} differs from ${pages[0].label}`);
  for (const p of pages) assert.equal((await syncState(p)).status, "synced", `${p.label} is not synced`);
}

async function step(name, fn) {
  await fn();
  console.log("ok  " + name);
}

async function main() {
  const server = await serve();
  const browser = await chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { executablePath: "/opt/pw-browsers/chromium" });
  let key;
  try {
    const a = await device(browser, "A", { width: 390, height: 844 });
    const b = await device(browser, "B", { width: 1440, height: 900 });

    await step("A turns sync on", async () => {
      await openPanel(a);
      await shot(a, "off-phone");
      await a.getByRole("button", { name: "Turn on sync" }).click();
      await a.fill("#syncBody input", "Sam");
      await a.getByRole("button", { name: "Continue" }).click();
      key = (await a.locator(".key-group").allTextContents()).join("-");
      assert.match(key, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){5}-[A-Z2-7]{2}$/);
      await a.check("#keySaved");
      await a.getByRole("button", { name: "Done" }).click();
      await a.getByText("This device", { exact: true }).waitFor();
      const s = await syncState(a);
      assert.equal(s.file.version, 1);
      assert.equal(s.recoveryKey, "", "the recovery key must not be stored");
      await a.keyboard.press("Escape");
    });

    await step("B joins with the recovery key and gets A's notes", async () => {
      const welcomeA = (await bodies(a))[0];
      await openPanel(b);
      await b.getByRole("button", { name: "Link to an existing device" }).click();
      await shot(b, "link-desktop");
      await b.fill("#syncBody input", key.toLowerCase().replaceAll("-", " "));
      await b.getByRole("button", { name: "Restore" }).click();
      await b.getByText("Device 1").waitFor();   // A, as seen from B
      await shot(b, "overview-desktop");
      await b.keyboard.press("Escape");
      await converge(a, b);
      assert.deepEqual(await bodies(b), [welcomeA], "B keeps only one welcome note");
    });

    await step("a note added on A arrives on B", async () => {
      await addNote(a, sample.s02);
      await converge(a, b);
      assert.ok((await bodies(b)).includes(sample.s02));
    });

    await step("notes added on both at once end up on both", async () => {
      await Promise.all([addNote(a, sample.s05), addNote(b, sample.s06)]);
      await converge(a, b);
      const all = await bodies(a);
      assert.ok(all.includes(sample.s05) && all.includes(sample.s06));
    });

    await step("the same note edited on both keeps both versions", async () => {
      const before = (await bodies(a)).length;
      await Promise.all([
        a.evaluate(t => { const n = window.__store.allNotes().find(x => x.body === t); window.__store.setBody(n.id, t + "\n\nA"); }, sample.s02),
        b.evaluate(t => { const n = window.__store.allNotes().find(x => x.body === t); window.__store.setBody(n.id, t + "\n\nB"); }, sample.s02),
      ]);
      await converge(a, b);
      assert.equal((await bodies(a)).length, before + 1, "a conflict copy is added");
    });

    await step("A removes B; B is locked out, A keeps syncing", async () => {
      await openPanel(a);
      await a.getByRole("button", { name: "Remove Device 2" }).click();
      await shot(a, "remove-phone");
      await a.getByRole("button", { name: "Remove", exact: true }).click();
      await a.getByText("Device 2 removed").waitFor();
      await a.keyboard.press("Escape");
      await sync(b);
      const s = await syncState(b);
      assert.equal(s.status, "error");
      assert.match(s.error, /removed/, JSON.stringify(s));
      await addNote(a, sample.s07);
      await converge(a);
    });

    await step("C restores with the recovery key after the removal", async () => {
      const c = await device(browser, "C", { width: 820, height: 1180 });
      await openPanel(c);
      await c.getByRole("button", { name: "Link to an existing device" }).click();
      await c.fill("#syncBody input", key);
      await c.getByRole("button", { name: "Restore" }).click();
      await c.getByText("This device", { exact: true }).waitFor();
      await shot(c, "overview-tablet");
      await converge(a, c);
      assert.ok((await bodies(c)).includes(sample.s07));
    });

    await step("without a server, sync can't be turned on", async () => {
      const d = await device(browser, "D", { width: 390, height: 844 }, false);
      await openPanel(d);
      await d.getByText("This copy of the app has no sync server.").waitFor();
      await shot(d, "no-server-phone");
    });
  } finally {
    await browser.close();
    server.close();
  }
  if (errors.length) throw new Error("page errors:\n  " + errors.join("\n  "));
  console.log("all sync steps passed");
}

main().catch(err => { console.error("FAILED: " + (err.stack || err.message)); process.exitCode = 1; });

#!/usr/bin/env node
// End-to-end test of real sync, run by scripts/test-sync.sh against a local
// server on 127.0.0.1:8765. Browser contexts stand in for devices: A turns
// sync on, B joins with the recovery key, D links by QR code (A really scans
// it: Chromium's fake camera plays a video of D's code), all edit (also the
// same note at once), A removes B, and C restores. Every step checks that the
// devices end up with the same file. Note texts come from app/sample/notes.md.
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
const CAMERA = path.join(require("os").tmpdir(), `notedown-e2e-camera-${process.pid}.y4m`);   // read when a camera opens
// User agents, so each device suggests its own name (core/linking.js → deviceLabel).
const AGENTS = {
  A: "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  B: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  C: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  D: "Mozilla/5.0 (Linux; Android 14; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36",
};
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
  const context = await browser.newContext({ viewport, hasTouch: viewport.width < 600, isMobile: viewport.width < 600, userAgent: AGENTS[name] });
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

// The fake camera's video: one still frame of the QR code of `text`.
async function showToCamera(text) {
  const { default: qrcode } = await import(path.join(ROOT, "app/vendor/qrcode.esm.js"));
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  const n = code.getModuleCount(), W = 640, H = 480, px = 6, left = (W - n * px) >> 1, top = (H - n * px) >> 1;
  const y = Buffer.alloc(W * H, 235);
  for (let r = 0; r < n * px; r++) for (let x = 0; x < n; x++) {
    if (code.isDark(Math.floor(r / px), x)) y.fill(16, (top + r) * W + left + x * px, (top + r) * W + left + x * px + px);
  }
  const frame = Buffer.concat([Buffer.from("FRAME\n"), y, Buffer.alloc(W * H / 2, 128)]);
  fs.writeFileSync(CAMERA, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), frame, frame]));
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
  const browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { executablePath: "/opt/pw-browsers/chromium" }),
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--use-file-for-fake-video-capture=" + CAMERA],
  });
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
      await b.getByText("Chrome on Android").waitFor();   // A, as seen from B
      await shot(b, "overview-desktop");
      await b.keyboard.press("Escape");
      await converge(a, b);
      assert.deepEqual(await bodies(b), [welcomeA], "B keeps only one welcome note");
    });

    let d;
    await step("D links by QR code: A scans D's code and confirms", async () => {
      d = await device(browser, "D", { width: 390, height: 844 });
      await addNote(d, sample.s04);   // D's own note joins the synced ones
      await openPanel(d);
      await d.getByRole("button", { name: "Link to an existing device" }).click();
      const code = await d.locator(".qr[data-code]").getAttribute("data-code");
      assert.match(code, /^notedown:link\?v=1&slot=[\w-]{22}&sign=[\w-]{43}&enc=[\w-]{43}&name=NoteDown\+app\+on\+Android$/);
      await shot(d, "link-qr-phone");
      await showToCamera("https://example.org");   // first some other QR code: refused
      await openPanel(a);
      await a.getByRole("button", { name: "Link a device" }).click();
      await a.getByText("That's not the code of a new NoteDown device.").waitFor({ timeout: 15000 });
      await shot(a, "scan-wrong-phone");
      await a.keyboard.press("Escape");
      await showToCamera(code);
      await a.getByRole("button", { name: "Link a device" }).click();
      await a.getByText("NoteDown app on Android").waitFor({ timeout: 15000 });   // scanned: the confirmation
      await shot(a, "confirm-link-phone");
      await a.getByRole("button", { name: "Link", exact: true }).click();
      await a.getByText("Device linked").waitFor();
      await d.getByText("This device", { exact: true }).waitFor({ timeout: 15000 });
      await shot(d, "overview-linked-phone");
      for (const p of [a, d]) await p.keyboard.press("Escape");
      await converge(a, b, d);
      const all = await bodies(d);
      assert.ok(all.includes(sample.s04), "D's own note is synced");
      assert.equal((await syncState(d)).name, "Sam", "the display name came with the relay message");
      assert.match(await fileText(a), /<!-- device id=\S+ name=NoteDown%20app%20on%20Android -->/);
    });

    await step("a scanned code that expired or isn't a link code is refused", async () => {
      await assert.rejects(a.evaluate(() => window.__sync.linkDevice("https://example.org")), /not the code/);
      const used = await d.evaluate(() => document.querySelector(".qr[data-code]")?.dataset.code);
      assert.equal(used, undefined, "D shows no code any more");
      const stale = "notedown:link?v=1&slot=AAAAAAAAAAAAAAAAAAAAAA&sign=" + "A".repeat(43) + "&enc=" + "A".repeat(43) + "&name=x";
      await assert.rejects(a.evaluate(t => window.__sync.linkDevice(t), stale), /expired/);
    });

    await step("a note added on A arrives on B", async () => {
      await addNote(a, sample.s02);
      await converge(a, b, d);
      assert.ok((await bodies(b)).includes(sample.s02) && (await bodies(d)).includes(sample.s02));
    });

    await step("B picks up a change on A by itself within the 5 s poll", async () => {
      // B has idled, so its poll delay has grown; getting the focus makes it 5 s again.
      await b.evaluate(() => window.dispatchEvent(new Event("focus")));
      await addNote(a, sample.s08);
      await sync(a);
      await b.waitForFunction(body => window.__store.allNotes().some(n => n.body === body), sample.s08, { timeout: 8000 });
      await converge(a, b, d);
      // Opening Sync & sharing syncs too: "Syncing…", then the time at the bottom.
      await openPanel(b);
      await b.locator("#syncFoot", { hasText: "Syncing…" }).waitFor();
      await b.locator("#syncFoot", { hasText: "Synced · just now" }).waitFor();
      await b.locator("#syncBody", { hasText: /MB of 2 MB used/ }).waitFor();   // the storage line, from the file list
      assert.equal(await b.locator(".storage-bar").getAttribute("role"), "progressbar");
      await b.keyboard.press("Escape");
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
      await a.getByRole("button", { name: "Remove Chrome on Windows" }).click();
      await shot(a, "remove-phone");
      await a.getByRole("button", { name: "Remove", exact: true }).click();
      await a.getByText("Chrome on Windows removed").waitFor();
      await a.keyboard.press("Escape");
      await sync(b);
      const s = await syncState(b);
      assert.equal(s.status, "error");
      assert.match(s.error, /removed/, JSON.stringify(s));
      await addNote(a, sample.s07);
      await converge(a, d);
      assert.doesNotMatch(await fileText(a), /name=Chrome%20on%20Windows/, "B's name is gone");
    });

    let c;
    await step("C restores with the recovery key after the removal", async () => {
      c = await device(browser, "C", { width: 820, height: 1180 });
      await openPanel(c);
      await c.getByRole("button", { name: "Link to an existing device" }).click();
      await c.fill("#syncBody input", key);
      await c.getByRole("button", { name: "Restore" }).click();
      await c.getByText("This device", { exact: true }).waitFor();
      await shot(c, "overview-tablet");
      await converge(a, c, d);
      assert.ok((await bodies(c)).includes(sample.s07));
      for (const name of ["Chrome on Android", "NoteDown app on Android"]) await c.getByText(name).waitFor();
    });

    await step("C signs out: erased, off A's device list, A keeps syncing", async () => {
      // C's panel is still open on the overview from restoring.
      await c.getByRole("button", { name: "Sign out this device" }).click();
      await c.getByText("Your notes stay on your other devices.").waitFor();
      await shot(c, "sign-out-tablet");
      // Offline, signing out fails and erasing alone is offered; nothing is erased yet.
      await c.context().setOffline(true);
      await c.getByRole("button", { name: "Sign out and erase", exact: true }).click();
      await c.getByRole("button", { name: "Erase without signing out" }).waitFor();
      await c.getByText("Changes not synced yet are lost").waitFor();
      await shot(c, "sign-out-failed-tablet");
      assert.equal((await syncState(c)).enabled, true, "still signed in");
      await c.context().setOffline(false);
      await Promise.all([
        c.waitForNavigation(),
        c.getByRole("button", { name: "Sign out and erase", exact: true }).click(),
      ]);
      await c.waitForFunction(() => document.body.dataset.ready === "1");
      await c.evaluate(async () => { window.__store = await import("/app/js/store.js"); });
      const left = await c.evaluate(async () => ({
        keys: Object.keys(localStorage).sort(),
        databases: (await indexedDB.databases()).map(d => d.name),
        sync: window.__store.state.sync.enabled,
        notes: window.__store.allNotes().length,
      }));
      assert.equal(left.sync, false, "sync is off");
      assert.equal(left.notes, 1, "first start: the welcome note");
      assert.deepEqual(left.databases, [], "no IndexedDB left");
      assert.ok(left.keys.every(k => ["notedown.api", "notedown.file", "notedown.shared", "notedown.sync"].includes(k)), `only first-start keys: ${left.keys}`);
      await shot(c, "signed-out-tablet");
      // A's verified list no longer has C, and A, D keep syncing.
      await sync(a);
      await openPanel(a);
      await a.getByText("Chrome on Linux").waitFor({ state: "detached" });
      await a.keyboard.press("Escape");
      await addNote(a, sample.s03);
      await converge(a, d);
      assert.ok((await bodies(d)).includes(sample.s03));
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
    fs.rmSync(CAMERA, { force: true });
  }
  if (errors.length) throw new Error("page errors:\n  " + errors.join("\n  "));
  console.log("all sync steps passed");
}

main().catch(err => { console.error("FAILED: " + (err.stack || err.message)); process.exitCode = 1; });

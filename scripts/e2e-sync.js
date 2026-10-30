#!/usr/bin/env node
// End-to-end test of real sync, run by scripts/test-sync.sh against a local
// server on 127.0.0.1:8765. Browser contexts stand in for devices: A turns
// sync on, B joins with the recovery key, D links by QR code (A really scans
// it: Chromium's fake camera plays a video of D's code; an answer from another identity without the code's secret
// is refused), all edit (also the same note at once), a key or an older state a server swaps in is refused, A removes B, and C restores. Then contacts: E (Lea) pastes
// A's invitation link, A confirms the request on the card above the notes; F (Tom)
// scans A's "My code" with the fake camera and A declines; stale, own and
// repeated invitations are refused. Then shared files: A shares notes with Lea, both edit (also at once),
// a shared note another member deletes waits in every member's trash, a restored device gets the shared
// files, removing a device renews the keys of the shared files too,
// a merge across circles creates the file of everyone involved, removing a person moves the note into a
// new file and the removed person's concurrent edit lands in the private file. Last, the server owner (Sam's
// identity, made admin on a second server process on the same database) publishes a news post that reaches both of
// Sam's devices (seen on one, seen on both; archived, gone with its marker), takes a backup, both of Sam's devices edit on,
// the backup is restored, and no note is lost; with version history switched on, Sam's private file keeps its
// older states through a key renewal, a restore (and its undo) reaches both devices and "Back up now" keeps the current state.
// Every step checks that the devices end up
// with the same file. Note texts come from app/sample/notes.md.
//
//   scripts/test-sync.sh [--shots <dir>]   (screenshots of the panel pages)
"use strict";
const fs = require("fs");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const assert = require("assert/strict");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const API = "http://127.0.0.1:8765";
const ADMIN_API = "http://127.0.0.1:8768";   // a second server on the same database that knows the admin
const PORT = 8766;   // the origin the server allows (CORS_ORIGINS in test-sync.sh)
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".md": "text/markdown", ".json": "application/json", ".svg": "image/svg+xml" };
const CAMERA = path.join(require("os").tmpdir(), `notedown-e2e-camera-${process.pid}.y4m`);   // read when a camera opens
// User agents, so each device suggests its own name (core/linking.js → deviceLabel).
const AGENTS = {
  A: "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  B: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  C: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  E: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  F: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  G: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  H: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  D: "Mozilla/5.0 (Linux; Android 14; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36",
  O: "Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0",
  P: "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
};
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;

// Bodies of the sample news posts (app/sample/news.md), by id.
const sampleNews = Object.fromEntries(fs.readFileSync(path.join(ROOT, "app/sample/news.md"), "utf8")
  .split(/^(?=<!-- note )/m).map(part => [/id=(\S+)/.exec(part)?.[1], part.replace(/^<!--.*-->\n/, "").trim()]));

// Bodies of the sample notes, by id.
const sample = Object.fromEntries(fs.readFileSync(path.join(ROOT, "app/sample/notes.md"), "utf8")
  .split(/^(?=<!-- note )/m).map(part => [/id=(\S+)/.exec(part)?.[1], part.replace(/^<!--.*-->\n/, "").trim()]));

function serve() {
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
    const found = fs.existsSync(file) && fs.statSync(file).isDirectory() ? path.join(file, "index.html") : file;   // like a static host
    if (!found.startsWith(ROOT) || !fs.existsSync(found) || fs.statSync(found).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(found)] || "application/octet-stream" });
    fs.createReadStream(found).pipe(res);
  });
  return new Promise(resolve => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

const errors = [];

// The app's modules, for the test to call (again after a page was loaded anew).
const loadModules = page => page.evaluate(async () => {
  window.__store = await import("/app/js/store.js");
  window.__sync = await import("/app/js/sync/client.js");
  window.__contacts = await import("/app/js/sync/contacts.js");
  window.__notesFile = await import("/app/js/core/notes-file.js");
  window.__crypto = await import("/app/js/core/crypto.js");
  window.__keystore = await import("/app/js/sync/keystore.js");
});

async function device(browser, name, viewport, api = true) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width < 600, isMobile: viewport.width < 600, userAgent: AGENTS[name] });
  const page = await context.newPage();
  page.on("pageerror", e => errors.push(`${name}: ${e.message}`));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
  await page.goto(`http://127.0.0.1:${PORT}/app/index.html` + (api ? `?api=${API}` : ""));
  await page.waitForFunction(() => document.body.dataset.ready === "1");
  await loadModules(page);
  page.label = name;
  return page;
}

const sync = page => page.evaluate(() => window.__sync.syncNow());
const fileText = page => page.evaluate(() => window.__store.fileText());
const syncState = page => page.evaluate(() => window.__store.state.sync);
const bodies = page => page.evaluate(() => window.__store.allNotes().map(n => n.body));
const addNote = (page, body) => page.evaluate(b => window.__store.addNote(b), body);

// Sync & sharing as its own panel, as the app's other ways in open it (People's "+", the storage hint), so one
// Esc closes it. The round button right of the search reaches it as the settings' first row (checked once in
// turnOnSync).
async function openPanel(page) {
  await page.evaluate(async () => (await import("/app/js/ui/sync-panel.js")).openSyncPanel());
}

// Turns sync on through the panel, as a new user does; closes the panel. → the recovery key shown.
async function turnOnSync(page, name) {
  await page.click("#syncBtn");
  await page.locator("#syncBody").getByText("Sync & sharing", { exact: true }).first().click();
  await page.locator("#syncBody").getByRole("button", { name: "Turn on sync" }).click();
  await page.fill("#syncBody input", name);
  await page.getByRole("button", { name: "Continue" }).click();
  const key = (await page.locator(".key-group").allTextContents()).join("-");
  await page.check("#keySaved");
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByText("This device", { exact: true }).waitFor();
  // Back to the settings, then closed.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  return key;
}

// "Add contact" → "Paste link" with `link`; leaves the page on "Name the contact".
async function pasteLink(page, link) {
  await openPanel(page);
  await page.getByRole("button", { name: "Add contact" }).click();
  await page.fill('input[aria-label="Paste link"]', link);
  await page.getByRole("button", { name: "Paste link", exact: true }).click();
  await page.getByRole("heading", { name: "Name the contact" }).waitFor();
}

const contactLines = page => fileText(page).then(t => t.match(/<!-- contact .*-->/g) || []);

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

// ---------- shared files ----------

const ident = async page => (page.ident ||= await page.evaluate(() => window.__store.state.sync.identity));
const noteId = (page, body) => page.evaluate(b => window.__store.allNotes().find(n => n.body === b)?.id, body);
const circleOfNote = (page, id) => page.evaluate(i => window.__store.circleOf(i), id);
const noteBody = (page, id) => page.evaluate(i => window.__store.note(i)?.body, id);
const setBody = (page, id, body) => page.evaluate(([i, b]) => window.__store.setBody(i, b), [id, body]);

// The text of the shared file of `members` (pages, the viewer included), as `page` holds it; null if it has none.
async function circleText(page, members) {
  const mine = await ident(page);
  const key = (await Promise.all(members.map(ident))).filter(m => m !== mine).sort().join("+");
  return page.evaluate(k => {
    const entry = window.__store.sharedFiles().find(x => x.key === k);
    return entry ? window.__notesFile.serializeNotesFile(entry.file) : null;
  }, key);
}

// The sync record of the shared file of `members`: { id, version, base }.
async function circleRecord(page, members) {
  const mine = await ident(page);
  const key = (await Promise.all(members.map(ident))).filter(m => m !== mine).sort().join("+");
  return page.evaluate(k => window.__store.state.sync.files[k], key);
}

// Syncs `pages` until they hold the same shared file of `members`.
async function convergeShared(members, ...pages) {
  for (const p of [...pages, ...pages]) await sync(p);
  const texts = await Promise.all(pages.map(p => circleText(p, members)));
  assert.notEqual(texts[0], null, "the shared file exists");
  for (const [i, t] of texts.entries()) assert.equal(t, texts[0], `${pages[i].label} differs from ${pages[0].label} in the shared file`);
  for (const p of pages) assert.equal((await syncState(p)).status, "synced", `${p.label} is not synced`);
  return texts[0];
}

// `inviter` and `requester` become contacts, through the API instead of the panel (covered above).
async function befriend(inviter, requester, nameForInviter, nameForRequester) {
  const link = await inviter.evaluate(async () => (await window.__contacts.createInvitation("link")).text);
  await requester.evaluate(([t, n]) => window.__contacts.sendRequest(t, n), [link, nameForInviter]);
  await sync(inviter);
  const request = await inviter.evaluate(() => window.__store.state.sync.requests[0].id);
  await inviter.evaluate(([i, n]) => window.__contacts.confirmRequest(i, n), [request, nameForRequester]);
  await sync(requester);
}

// Closes the panel and the snackbar a step left open, for a clean screenshot.
const tidy = page => page.evaluate(async () => {
  (await import("/app/js/ui/snackbar.js")).hideSnackbar();
  (await import("/app/js/ui/sync-panel.js")).closePanel();
});

const fileKeyOf = (page, record) => page.evaluate(async r => window.__crypto.b64u(await window.__keystore.getSecret("file:" + r.server + "/" + r.id)), record);

// Starts a second server process on the same database with `identity` as the admin (the first one can't know it:
// the identity exists only after a device turned sync on). Resolves once it answers; `.kill()` stops it.
async function startAdminServer(identity) {
  const proc = spawn(process.env.E2E_UVICORN, ["notedown_server.main:app", "--host", "127.0.0.1", "--port", "8768", "--log-level", "warning"], {
    cwd: path.join(ROOT, "server"), stdio: "inherit",
    env: { ...process.env, DATABASE_URL: process.env.E2E_DATABASE_URL, SERVER_SECRET: "e2e-secret", RATE_LIMITS: "off", CORS_ORIGINS: `http://127.0.0.1:${PORT}`, ADMIN_IDENTITIES: identity },
  });
  for (let i = 0; i < 100; i++) {
    if (await fetch(ADMIN_API + "/health").then(r => r.ok, () => false)) return proc;
    await new Promise(r => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error("the admin server did not start");
}

// Stops the admin server and waits until it is gone, so the next one doesn't answer the health check of this one.
function stopAdminServer(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => { proc.once("exit", resolve); proc.kill(); });
}

// An admin call made from `page` with its device's keys (the way the admin page signs in). → { status, body } with the body as text.
const adminCall = (page, method, route, body) => page.evaluate(async ([base, method, route, body]) => {
  const s = window.__store.state.sync, keys = await window.__crypto.deviceKeysFromSeeds(await window.__keystore.getSecret("device"));
  const level = String((await import("/app/js/sync/api.js")).CLIENT_LEVEL);
  const get = async (path, init = {}) => fetch(base + path, { ...init, headers: { ...init.headers, "NoteDown-Client": level } });
  const { challenge } = await (await get("/v1/auth/challenge")).json();
  const sig = await window.__crypto.signChallenge(keys.sign.privateKey, { server: new URL(base).host, identity: s.identity, device: s.device, challenge });
  const { token } = await (await get("/v1/auth/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identity: s.identity, device: s.device, challenge, sig }) })).json();
  const res = await get(route, { method, headers: { Authorization: "Bearer " + token }, body });
  return { status: res.status, body: await res.text() };
}, [ADMIN_API, method, route, body]);

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
      await a.locator("#syncBody").getByRole("button", { name: "Turn on sync" }).click();
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
      // The device keys are seeds in the encrypted vault (backlog #61); nothing goes to IndexedDB `notedown`.
      assert.deepEqual(await a.evaluate(async () => {
        const seeds = await window.__keystore.getSecret("device");
        return [Object.keys(seeds), Object.values(seeds).every(v => v instanceof Uint8Array), (await indexedDB.databases()).some(d => d.name === "notedown")];
      }), [["sign", "enc", "kem"], true, false]);
      await a.keyboard.press("Escape");
    });

    await step("B joins with the recovery key and gets A's notes", async () => {
      const welcomeA = await bodies(a);
      await openPanel(b);
      await b.getByRole("button", { name: "Link to an existing device" }).click();
      await shot(b, "link-desktop");
      await b.fill("#syncBody input", key.toLowerCase().replaceAll("-", " "));
      await b.getByRole("button", { name: "Restore" }).click();
      await b.getByText("Chrome on Android").waitFor();   // A, as seen from B
      await shot(b, "overview-desktop");
      await b.keyboard.press("Escape");
      await converge(a, b);
      assert.deepEqual(await bodies(b), welcomeA, "B keeps only one set of welcome notes");
    });

    let d;
    await step("D links by QR code: A scans D's code and confirms", async () => {
      d = await device(browser, "D", { width: 390, height: 844 });
      await addNote(d, sample.s04);   // D's own note joins the synced ones
      await openPanel(d);
      await d.getByRole("button", { name: "Link to an existing device" }).click();
      const code = await d.locator(".qr[data-code]").getAttribute("data-code");
      assert.match(code, /^notedown:link\?v=2&slot=[\w-]{22}&sign=[\w-]{43}&enc=[\w-]{43}&kem=[\w-]{43}&s=[\w-]{22}&name=NoteDown\+app\+on\+Android&srv=[\w%.-]+$/);
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
      assert.match(await fileText(a), /<!-- device id=\S+ name=NoteDown%20app%20on%20Android synced=\S+Z -->/);
    });

    await step("a scanned code that expired or isn't a link code is refused", async () => {
      await assert.rejects(a.evaluate(() => window.__sync.linkDevice("https://example.org")), /not the code/);
      const used = await d.evaluate(() => document.querySelector(".qr[data-code]")?.dataset.code);
      assert.equal(used, undefined, "D shows no code any more");
      const stale = "notedown:link?v=2&slot=AAAAAAAAAAAAAAAAAAAAAA&sign=" + "A".repeat(43) + "&enc=" + "A".repeat(43) + "&kem=" + "A".repeat(43) + "&s=" + "A".repeat(22) + "&name=x";
      await assert.rejects(a.evaluate(t => window.__sync.linkDevice(t), stale), /expired/);
      // A code of version 1 (no secret) is no code any more, however it looks otherwise.
      await assert.rejects(a.evaluate(t => window.__sync.linkDevice(t), stale.replace("v=2", "v=1").replace(/&s=A+/, "")), /not the code/);
    });

    await step("a relay answer without the code's secret is refused (security review M6)", async () => {
      // Mallory stands for a malicious server with an identity of its own: it knows the new device's public keys (from the real
      // device list), puts the device on its own list, seals a well-formed answer naming its identity and fills the slot. Only the
      // code held the secret, so it has to guess one: linkDevice does all of that when it is given the code with another secret.
      const m = await device(browser, "O", { width: 1440, height: 900 });
      await turnOnSync(m, "Mallory");
      const n = await device(browser, "P", { width: 820, height: 1180 });
      const notes = await bodies(n);
      await openPanel(n);
      await n.getByRole("button", { name: "Link to an existing device" }).click();
      const code = await n.locator(".qr[data-code]").getAttribute("data-code");
      const secret = /&s=([\w-]{22})&/.exec(code)[1];
      const guess = "W".repeat(22);
      assert.notEqual(secret, guess);
      await m.evaluate(t => window.__sync.linkDevice(t), code.replace("&s=" + secret, "&s=" + guess));
      // The new device is on Mallory's verified list: without the secret check it would find itself active there and join.
      const sign = new URLSearchParams(code.slice("notedown:link?".length)).get("sign");
      assert.equal(await m.evaluate(async s => {
        const devices = await window.__sync.loadDevices();
        return devices.get(await window.__crypto.keyId(window.__crypto.fromB64u(s, 32)))?.active;
      }, sign), true, "the new device is on Mallory's list");
      // The answer is as well-formed as the one in D's step, which joins; the secret is all that differs.
      await n.getByText("Couldn't link: The other device sent an answer this device can't read").waitFor({ timeout: 15000 });
      await shot(n, "link-refused-tablet");
      const s = await syncState(n);
      assert.deepEqual([s.enabled, s.identity, s.identityKey, s.device], [false, "", "", ""], "sync stays off, no identity adopted");
      assert.equal(await n.evaluate(async () => (await window.__keystore.getSecret("device")) ?? null), null, "no device keys were taken over");
      assert.deepEqual(await bodies(n), notes, "the new device's notes are untouched");
      await m.context().close();
      await n.context().close();
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

    await step("a file key the server swaps in is refused: unsigned or signed by a stranger, B keeps its key and notes", async () => {
      // A malicious server: a version of A's private file under a key it chose, wrapped for B.
      const r = (await syncState(b)).file, bDevice = (await syncState(b)).device;
      const before = { key: await fileKeyOf(b, r), text: await fileText(b) };
      const ownWrap = page => page.evaluate(async () => {
        const s = window.__store.state.sync, keys = await window.__crypto.deviceKeysFromSeeds(await window.__keystore.getSecret("device"));
        const { createApis } = await import("/app/js/sync/api.js");
        return (await createApis(() => ({ identity: s.identity, device: s.device, sign: keys.sign.privateKey }))(s.server).getFile(s.file.id)).key;
      });
      const original = await ownWrap(b), originalA = await ownWrap(a);   // a renewal replaces every wrap of the file
      const swap = (page, mode) => page.evaluate(async ({ to, mode }) => {
        const c = window.__crypto, s = window.__store.state.sync, keys = await window.__crypto.deviceKeysFromSeeds(await window.__keystore.getSecret("device"));
        const { createApis } = await import("/app/js/sync/api.js");
        const api = createApis(() => ({ identity: s.identity, device: s.device, sign: keys.sign.privateKey }))(s.server);
        const target = (await window.__sync.loadDevices()).get(to);
        const evil = c.generateFileKey(), current = await api.getFile(s.file.id);
        let wrap = await c.wrapFileKey(evil, { enc: target.enc, kem: target.kem });
        if (mode === "stranger") {   // signed, but with a key no member's device has, claiming to be A
          const stranger = await c.generateDeviceKeys();
          wrap = await c.signWrap(wrap, { file: s.file.id, to, gen: 99 }, s.device, stranger.sign.privateKey);
        }
        await api.putFile(s.file.id, {
          base_version: current.version, ciphertext: await c.encryptFile(evil, window.__store.fileText(), { file: s.file.id, version: current.version + 1 }),
          keys: { [to]: wrap }, previous_key: await c.sealPreviousKey(evil, c.generateFileKey()),
        });
      }, { to: bDevice, mode });
      for (const mode of ["unsigned", "stranger"]) {
        await swap(a, mode);
        await sync(b);
        const st = await syncState(b);
        assert.equal(st.status, "error", mode);
        assert.match(st.error, /isn't signed by a device of its members/, mode);
        assert.equal(await fileKeyOf(b, r), before.key, `${mode}: B kept its key`);
        assert.equal(await fileText(b), before.text, `${mode}: B's notes are unchanged`);
      }
      // The real key comes back (the devices' own signed wraps), A uploads its notes under it again: both sync on.
      await a.evaluate(async ({ to, original, originalA, key }) => {
        const c = window.__crypto, s = window.__store.state.sync, keys = await window.__crypto.deviceKeysFromSeeds(await window.__keystore.getSecret("device"));
        const { createApis } = await import("/app/js/sync/api.js");
        const api = createApis(() => ({ identity: s.identity, device: s.device, sign: keys.sign.privateKey }))(s.server);
        const current = await api.getFile(s.file.id);
        await api.addKeys(s.file.id, { [to]: original, [s.device]: originalA });
        await api.putFile(s.file.id, { base_version: current.version, ciphertext: await c.encryptFile(c.fromB64u(key), window.__store.fileText(), { file: s.file.id, version: current.version + 1 }) });
      }, { to: bDevice, original, originalA, key: before.key });
      await converge(a, b);
    });

    await step("an older state the server hands out as a newer version is refused: B keeps its notes (security review H2)", async () => {
      // A malicious server (or a stolen token): the ciphertext of an earlier version uploaded again as the newest one.
      const replay = (page, mode) => page.evaluate(async mode => {
        const s = window.__store.state.sync, keys = await window.__crypto.deviceKeysFromSeeds(await window.__keystore.getSecret("device"));
        const { createApis } = await import("/app/js/sync/api.js");
        const api = createApis(() => ({ identity: s.identity, device: s.device, sign: keys.sign.privateKey }))(s.server);
        if (mode === "capture") return (await api.getFile(s.file.id)).ciphertext;
        const current = await api.getFile(s.file.id);
        await api.putFile(s.file.id, { base_version: current.version, ciphertext: mode });
      }, mode);
      const old = await replay(a, "capture");
      await addNote(a, sample.s20);
      await converge(a, b);
      const before = await fileText(b);
      assert.ok(before.includes(sample.s20));
      await replay(a, old);
      await sync(b);
      const st = await syncState(b);
      assert.equal(st.status, "error");
      assert.match(st.error, /doesn't match its version/);
      assert.equal(await fileText(b), before, "the newer note is still on B");
      // A uploads its notes again on top: both sync on.
      await a.evaluate(async () => {
        const c = window.__crypto, s = window.__store.state.sync, keys = await window.__crypto.deviceKeysFromSeeds(await window.__keystore.getSecret("device"));
        const { createApis } = await import("/app/js/sync/api.js");
        const api = createApis(() => ({ identity: s.identity, device: s.device, sign: keys.sign.privateKey }))(s.server);
        const current = await api.getFile(s.file.id);
        const key = await window.__keystore.getSecret("file:" + s.server + "/" + s.file.id);
        await api.putFile(s.file.id, { base_version: current.version, ciphertext: await c.encryptFile(key, window.__store.fileText(), { file: s.file.id, version: current.version + 1 }) });
      });
      await converge(a, b);
      assert.ok((await bodies(b)).includes(sample.s20));
    });

    await step("the same note edited on both: lines added on both combine, the same line changed on both keeps both versions", async () => {
      const before = (await bodies(a)).length;
      const edit = (page, from, to) => page.evaluate(([f, t]) => { const n = window.__store.allNotes().find(x => x.body === f); window.__store.setBody(n.id, t); }, [from, to]);
      await Promise.all([edit(a, sample.s02, sample.s02 + "\n\nA"), edit(b, sample.s02, sample.s02 + "\n\nB")]);
      await converge(a, b);
      assert.equal((await bodies(a)).length, before, "no conflict copy (backlog #47)");
      const merged = (await bodies(a)).find(t => t.startsWith(sample.s02));
      assert.ok(merged.includes("\n\nA") && merged.includes("\n\nB"), "both additions are kept");
      await Promise.all([edit(a, merged, merged.replace(/\nA$|\nA\n/, m => m.replace("A", "A1"))), edit(b, merged, merged.replace(/\nA$|\nA\n/, m => m.replace("A", "A2")))]);
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
      const kept = (await bodies(b)).sort();
      await sync(b);
      const s = await syncState(b);
      assert.deepEqual([s.enabled, s.ended], [false, "removed"], JSON.stringify(s));
      assert.deepEqual((await bodies(b)).sort(), kept, "B keeps its notes");
      await b.locator("#syncNotice", { hasText: "This device was removed from sync" }).waitFor();
      await shot(b, "removed-desktop");
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
      assert.equal(left.notes, 4, "first start: the welcome notes");
      assert.deepEqual(left.databases, ["notedown-vault"], "only the fresh vault of the first start");
      assert.ok(left.keys.every(k => k === "notedown.api"), `nothing but the server address in plain localStorage: ${left.keys}`);
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

    // ---------- contacts ----------
    let e, f, link;
    await step("E (Lea) turns on sync and pastes A's invitation link; the request is pending", async () => {
      e = await device(browser, "E", { width: 1440, height: 900 });
      e.recoveryKey = await turnOnSync(e, "Lea");
      await openPanel(a);
      await a.getByRole("button", { name: "Add contact" }).click();
      await a.getByRole("tab", { name: "Invite by link" }).click();
      link = await a.locator('input[aria-label="Invitation link"]').inputValue();
      assert.match(link, /^http:\/\/127\.0\.0\.1:8766\/app\/invite\/#v=1&id=[\w-]{22}&s=[\w-]{22}&name=Sam&srv=[\w%.-]+$/);
      await a.getByText("The link works once, for 7 days.").waitFor();
      await shot(a, "invite-link-phone");
      await a.keyboard.press("Escape");
      await a.keyboard.press("Escape");
      await openPanel(e);
      await e.getByRole("button", { name: "Add contact" }).click();
      await shot(e, "add-contact-desktop");
      await e.keyboard.press("Escape");
      await e.keyboard.press("Escape");
      await pasteLink(e, "  " + link + "\n");
      assert.equal(await e.locator('input[aria-label="Contact name"]').inputValue(), "Sam", "the inviter's name is the suggestion");
      await shot(e, "name-contact-desktop");
      await e.getByRole("button", { name: "Send request" }).click();
      await e.getByText("Request sent to Sam").waitFor();
      await e.getByText("Waiting for confirmation").waitFor();
      await shot(e, "contact-pending-desktop");
      assert.match((await contactLines(e)).join(), /name=Sam color=1 pending=\S+ -->/);
      await e.keyboard.press("Escape");
    });

    await step("A sees the request card and confirms; both have each other as contacts", async () => {
      await sync(a);
      const card = a.locator("#requestCards .request-card");
      await card.getByText("Lea wants to be your contact").waitFor();
      await card.getByText("Opened your invitation link").waitFor();
      await shot(a, "request-card-phone");
      await card.getByRole("button", { name: "Confirm" }).click();
      assert.equal(await a.locator('input[aria-label="Contact name"]').inputValue(), "Lea");
      await shot(a, "request-page-phone");
      await a.locator("#syncBody").getByRole("button", { name: "Confirm" }).click();
      await a.getByText("Lea added").waitFor();
      await a.locator("#syncBody").getByText("Lea", { exact: true }).waitFor();
      await shot(a, "contacts-phone");
      assert.equal(await a.locator("#requestCards .request-card").count(), 0, "the card is gone");
      await a.keyboard.press("Escape");
      await sync(e);
      await e.getByText("Sam confirmed your request").waitFor();
      assert.doesNotMatch((await contactLines(e)).join(), /pending/, "E's contact is confirmed");
      await openPanel(e);
      await e.getByText("Waiting for confirmation").waitFor({ state: "detached" });
      await shot(e, "contacts-desktop");
      await e.keyboard.press("Escape");
      await converge(a, d);
      await converge(e);
      assert.match((await contactLines(a)).join(), /name=Lea color=1 -->/);
      assert.match((await contactLines(d)).join(), /name=Lea color=1 -->/, "A's other device has Lea too");
      assert.match((await contactLines(e)).join(), /name=Sam color=1 -->/);
    });

    await step("the invite page forwards a visited link into the app; a contact can't be added twice", async () => {
      const again = await a.evaluate(async () => (await window.__contacts.createInvitation("link")).text);
      await e.goto(again);
      await e.waitForFunction(() => document.body.dataset.ready === "1");
      await loadModules(e);   // the page was loaded anew
      await e.getByRole("heading", { name: "Name the contact" }).waitFor();
      assert.equal(await e.locator('input[aria-label="Contact name"]').inputValue(), "Sam");
      assert.equal(new URL(e.url()).hash, "", "the fragment is taken out of the address");
      await e.getByRole("button", { name: "Send request" }).click();
      await e.getByText("Sam is already your contact.").waitFor();
      await shot(e, "contact-error-desktop");
      await e.keyboard.press("Escape");
      await e.keyboard.press("Escape");
    });

    await step("F (Tom) scans A's My code; A sees the request at once and declines it", async () => {
      f = await device(browser, "F", { width: 820, height: 1180 });
      await turnOnSync(f, "Tom");
      await openPanel(a);
      await a.getByRole("button", { name: "My code" }).click();
      const code = await a.locator(".qr[data-code]").getAttribute("data-code");
      assert.match(code, /\/invite\/#v=1&id=/);
      await a.getByText("The code works once, for 10 minutes.").waitFor();
      await shot(a, "my-code-phone");
      await showToCamera(code);
      await openPanel(f);
      await f.getByRole("button", { name: "Add contact" }).click();
      await f.getByRole("heading", { name: "Name the contact" }).waitFor({ timeout: 15000 });   // scanned
      assert.equal(await f.locator('input[aria-label="Contact name"]').inputValue(), "Sam");
      await f.fill('input[aria-label="Contact name"]', "Samuel");
      await f.getByRole("button", { name: "Send request" }).click();
      await f.getByText("Request sent to Samuel").waitFor();
      await shot(f, "contact-pending-tablet");
      await sync(a);   // A is on "My code": the request opens by itself
      await a.locator("#syncBody").getByText("Tom wants to be your contact").waitFor();
      await a.locator("#syncBody").getByText("Scanned your code").waitFor();
      await shot(a, "request-code-phone");
      await a.locator("#syncBody").getByRole("button", { name: "Decline" }).click();
      await a.getByText("Request declined").waitFor();
      assert.equal(await a.locator("#requestCards .request-card").count(), 0);
      assert.doesNotMatch((await contactLines(a)).join(), /name=Tom/, "declined: no contact");
      await f.keyboard.press("Escape");
    });

    await step("a used, an own and a made-up invitation are refused", async () => {
      // A declined request is never reported back: F's contact stays pending until F removes it.
      await assert.rejects(f.evaluate(t => window.__contacts.sendRequest(t, "Sam"), link), /already sent a request to Samuel/);
      await f.evaluate(() => window.__contacts.removeContact(window.__store.state.file.contacts[0].id));
      await assert.rejects(f.evaluate(t => window.__contacts.sendRequest(t, "Sam"), link), /expired or was already used/);
      const own = await f.evaluate(async () => (await window.__contacts.createInvitation("link")).text);
      await assert.rejects(f.evaluate(t => window.__contacts.sendRequest(t, "Me"), own), /own code/);
      await assert.rejects(f.evaluate(() => window.__contacts.sendRequest("hello", "x")), /not a NoteDown invitation/);
      await pasteLink(f, link);
      await f.getByRole("button", { name: "Send request" }).click();
      await f.getByText("This code or link has expired or was already used").waitFor();
      await shot(f, "contact-expired-tablet");
      await f.keyboard.press("Escape");
      assert.deepEqual(await contactLines(f), [], "nothing was added");
    });

    // ---------- shared files ----------
    let g, noteN, noteM, noteK;
    const stateOf = page => page.evaluate(() => window.__store.state.sync);
    await step("A shares a note with Lea through the share dialog: the file is created, Lea sees it with Sam's avatar", async () => {
      noteN = (await addNote(a, sample.s09)).id;
      await tidy(a);
      await a.evaluate(async id => (await import("/app/js/ui/share-dialog.js")).openShareDialog([id]), noteN);
      await a.getByRole("checkbox", { name: "Lea" }).click();
      await shot(a, "share-dialog-phone");
      await a.getByRole("button", { name: "Save", exact: true }).click();
      await a.getByText("Shared with Lea").waitFor();
      assert.deepEqual(await circleOfNote(a, noteN), [await ident(e)]);
      await sync(a);
      assert.match(await fileText(a), new RegExp(`<!-- note id=${noteN} moved=\\S+ to=\\S+ -->`), "a moved marker naming the new file stays in the private file");
      await sync(e);
      assert.equal(await noteBody(e, noteN), sample.s09, "Lea has the note");
      assert.deepEqual(await circleOfNote(e, noteN), [await ident(a)]);
      assert.equal(await e.locator(`#list .note[data-id="${noteN}"] .shared-mark`).getAttribute("aria-label"), "Shared with Sam");
      await tidy(a);
      await a.locator(`#list .note[data-id="${noteN}"]`).scrollIntoViewIfNeeded();
      await shot(a, "shared-list-phone");
      await e.getByRole("tab", { name: "People" }).click();
      await e.locator("#peopleList").getByText("Sam").first().click();
      await shot(e, "people-filter-desktop");
      await e.getByRole("tab", { name: "Contents" }).click().catch(() => {});
      await convergeShared([a, e], a, e);
      await converge(a, d);
    });

    await step("Lea edits the shared note and Sam sees it; both edit at once: one conflict copy, the same file", async () => {
      await setBody(e, noteN, sample.s09 + "\n\nLea");
      await convergeShared([a, e], a, e);
      assert.equal(await noteBody(a, noteN), sample.s09 + "\n\nLea");
      await Promise.all([setBody(a, noteN, sample.s09 + "\n\nLea and Sam"), setBody(e, noteN, sample.s09 + "\n\nLea again")]);
      const text = await convergeShared([a, e], a, e);
      assert.equal((text.match(/<!-- note /g) || []).length, 2, "the same line changed on both: a conflict copy");
      assert.equal(await noteBody(a, noteN), await noteBody(e, noteN));
    });

    await step("a shared note another member deletes waits in every member's trash; restoring it for the circle empties both", async () => {
      const id = (await addNote(a, sample.s10)).id;
      await a.evaluate(([i, m]) => window.__store.shareNotes([i], [m]), [id, await ident(e)]);
      await convergeShared([a, e], a, e);
      await a.evaluate(i => window.__store.removeNotes([i]), id);
      await convergeShared([a, e], a, e);
      const trashed = page => page.evaluate(i => window.__store.trashNotes().find(n => n.id === i) || null, id);
      assert.equal((await trashed(a))?.kept, await ident(e), "in Sam's trash, marked with the circle");
      assert.equal((await trashed(e))?.kept, await ident(a), "in Lea's trash too");
      assert.equal((await trashed(e)).body, sample.s10);
      assert.equal(await circleText(e, [a, e]).then(t => t.includes(`id=${id} `)), false, "gone from the shared file");
      await e.evaluate(i => window.__store.restoreNotes([i]), id);
      await convergeShared([a, e], a, e);
      assert.deepEqual(await circleOfNote(a, id), [await ident(e)], "back in the circle");
      assert.equal(await trashed(a), null, "Sam's trash entry is gone, the note is back");
      assert.equal(await trashed(e), null);
      await converge(e);
    });

    await step("a note deleted on another own device waits in the trash there too, once", async () => {
      const id = (await addNote(a, sample.s11)).id;
      await converge(a, d);
      await a.evaluate(i => window.__store.removeNotes([i]), id);
      await converge(a, d);
      assert.ok(await d.evaluate(i => window.__store.trashNotes().some(n => n.id === i), id), "in D's trash");
      assert.equal((await fileText(d)).split(`id=${id} `).length - 1, 1, "one entry");
    });

    await step("a restored device gets the shared files", async () => {
      g = await device(browser, "G", { width: 820, height: 1180 });
      await g.evaluate(k => window.__sync.restore(k), key);
      await converge(a, d, g);
      assert.equal(await noteBody(g, noteN), await noteBody(a, noteN), "G reads the shared note");
      assert.deepEqual(await circleOfNote(g, noteN), [await ident(e)]);
      await convergeShared([a, e], a, d, g, e);
    });

    await step("A removes G: the keys of every file are renewed, Lea still reads and edits the shared file", async () => {
      const shared = await circleRecord(a, [a, e]), priv = (await stateOf(a)).file;
      const before = [await fileKeyOf(a, shared), await fileKeyOf(a, priv)];
      const gDevice = (await stateOf(g)).device;
      await a.evaluate(id => window.__sync.removeDevice(id), gDevice);
      assert.deepEqual((await stateOf(a)).renew, [], "nothing left to renew");
      const after = [await fileKeyOf(a, await circleRecord(a, [a, e])), await fileKeyOf(a, (await stateOf(a)).file)];
      assert.notEqual(after[0], before[0], "the shared file has a new key");
      assert.notEqual(after[1], before[1], "the private file has a new key");
      await sync(g);
      assert.equal((await stateOf(g)).ended, "removed");
      await sync(e);
      assert.equal(await fileKeyOf(e, await circleRecord(e, [a, e])), after[0], "Lea unwrapped the new key");
      await setBody(e, noteN, (await noteBody(e, noteN)) + "\n\nafter renewal");
      await convergeShared([a, e], a, d, e);
      assert.match(await noteBody(a, noteN), /after renewal$/);
      await converge(a, d);
    });

    await step("a merge across circles with Share with ... creates the file of everyone involved; a private copy writes to no shared file", async () => {
      await befriend(a, f, "Sam", "Tom");
      await converge(a, d);
      const q = (await addNote(a, sample.s12)).id;
      await a.evaluate(([i, m]) => window.__store.shareNotes([i], [m]), [q, await ident(f)]);
      await convergeShared([a, f], a, d, f);
      // Private copy: the sources stay, nothing is written to a shared file.
      const versions = async () => [(await circleRecord(a, [a, e])).version, (await circleRecord(a, [a, f])).version];
      const before = await versions();
      const copy = await a.evaluate(([x, y]) => window.__store.applyMerge([{ id: x, body: window.__store.note(x).body }, { id: y, body: window.__store.note(y).body }],
        { body: "Copy", created: null, due: null }, "copy").note.id, [noteN, q]);
      await converge(a, d);
      assert.deepEqual(await versions(), before, "the shared files are untouched");
      assert.deepEqual(await circleOfNote(a, copy), []);
      // Share with ...: the merged note goes into the file of Lea, Tom and Sam, whose key is wrapped for all their devices.
      noteM = await a.evaluate(([x, y]) => {
        const body = [x, y].map(i => window.__store.note(i).body).join("\n\n");
        return window.__store.applyMerge([{ id: x, body: null }, { id: y, body: null }], { body, created: null, due: null }, "share").note.id;
      }, [noteN, q]);
      assert.deepEqual(await circleOfNote(a, noteM), [await ident(e), await ident(f)].sort());
      await convergeShared([a, e, f], a, d, e, f);
      assert.equal(await noteBody(e, noteM), await noteBody(f, noteM));
      assert.deepEqual(await circleOfNote(f, noteM), [await ident(a), await ident(e)].sort());
      // Tom isn't Lea's contact: her name comes from the member marker she wrote into the shared file.
      assert.equal(await f.evaluate(id => window.__store.memberName(id), await ident(e)), "Lea");
      assert.match(await circleText(f, [a, e, f]), /<!-- member id=\S+ name=Lea -->/);
      await tidy(f);
      await f.evaluate(() => window.__store.setUi({ panelTab: "people" }));
      await f.locator("#peopleList").getByText(/Lea/).waitFor();
      await shot(f, "people-group-tablet");
      await f.evaluate(() => window.__store.setUi({ panelTab: "toc" }));
      await shot(f, "shared-list-tablet");
    });

    await step("removing Tom moves the note into a new file; Tom's concurrent edit lands in his private file", async () => {
      const before = await noteBody(f, noteM);
      await setBody(f, noteM, before + "\n\nTom, while being removed");
      await a.evaluate(([i, m]) => window.__store.shareNotes([i], [m]), [noteM, await ident(e)]);
      await sync(a);
      await sync(f);
      assert.deepEqual(await circleOfNote(f, noteM), [], "private on Tom's device");
      assert.equal(await noteBody(f, noteM), before + "\n\nTom, while being removed");
      assert.match(await fileText(f), new RegExp(`<!-- note id=${noteM} status=open`));
      await sync(e);
      assert.deepEqual(await circleOfNote(e, noteM), [await ident(a)]);
      assert.equal(await noteBody(e, noteM), before, "Lea has the note without Tom's edit");
      assert.match(await circleText(f, [a, e, f]), new RegExp(`<!-- note id=${noteM} moved=`), "the old file keeps the moved marker");
      await convergeShared([a, e], a, d, e);
      await converge(f);
    });

    await step("adding Tom again: Lea's concurrent edit follows the note into the new file", async () => {
      const before = await noteBody(e, noteM);
      await setBody(e, noteM, before + "\n\nLea, while Tom is added");
      await a.evaluate(([i, m, n]) => window.__store.shareNotes([i], [m, n]), [noteM, await ident(e), await ident(f)]);
      await sync(a);
      await sync(e);
      assert.deepEqual(await circleOfNote(e, noteM), [await ident(a), await ident(f)].sort());
      assert.equal(await noteBody(e, noteM), before + "\n\nLea, while Tom is added");
      await convergeShared([a, e, f], a, d, e, f);
      assert.equal(await noteBody(f, noteM), before + "\n\nLea, while Tom is added");
      // Tom's private copy from when he was removed is a note of its own now, not a second one with the same ID.
      const copies = await f.evaluate(() => window.__store.allNotes().filter(n => /while being removed/.test(n.body)).map(n => n.id));
      assert.equal(copies.length, 1);
      assert.notEqual(copies[0], noteM);
      assert.deepEqual(await circleOfNote(f, copies[0]), []);
      await converge(f);
    });

    await step("Tom leaves a note shared with Sam and Lea: it disappears for him, Sam's device moves it into the file of the two", async () => {
      await tidy(f);
      await f.evaluate(async id => (await import("/app/js/ui/share-dialog.js")).openShareDialog([id]), noteM);
      await shot(f, "leave-dialog-tablet");
      await f.getByRole("button", { name: "Leave" }).click();
      await f.getByText("You left the note").waitFor();
      assert.equal(await noteBody(f, noteM), undefined, "hidden at once");
      assert.match(await circleText(f, [a, e, f]), / left=\S+ -->/, "marked in the shared file");
      await sync(f);
      await sync(a);   // a remaining member moves it on
      assert.deepEqual(await circleOfNote(a, noteM), [await ident(e)]);
      assert.doesNotMatch(await circleText(a, [a, e]) , /left=/);
      await convergeShared([a, e], a, d, e);
      assert.deepEqual(await circleOfNote(e, noteM), [await ident(a)]);
      assert.match(await circleText(a, [a, e, f]), new RegExp(`<!-- note id=${noteM} moved=`), "the old file keeps the moved marker");
      await convergeShared([a, e, f], a, e, f);
      assert.equal(await noteBody(f, noteM), undefined, "Tom doesn't see it any more");
      assert.doesNotMatch(await fileText(f), new RegExp(`<!-- note id=${noteM} status`), "and it doesn't come back into his private file");
      // Later edits go into the file of the two, which Tom isn't a member of.
      await setBody(a, noteM, (await noteBody(a, noteM)) + "\n\nafter Tom left");
      await convergeShared([a, e], a, e);
      await sync(f);
      assert.equal(await noteBody(f, noteM), undefined);
      assert.equal(await f.evaluate(() => window.__store.allNotes().some(n => /after Tom left/.test(n.body))), false, "Tom can't read later edits");
      assert.equal(await e.evaluate(() => window.__store.allNotes().some(n => /after Tom left/.test(n.body))), true);
      noteK = (await addNote(a, sample.s13)).id;   // for the contact removal below
      await a.evaluate(([i, m]) => window.__store.shareNotes([i], [m]), [noteK, await ident(e)]);
      await convergeShared([a, e], a, d, e);
    });

    await step("removing a contact removes the pair on both sides", async () => {
      await openPanel(e);
      await e.getByRole("button", { name: "Remove Sam" }).click();
      await e.getByRole("button", { name: "Remove", exact: true }).click();
      await e.getByText("Sam removed").waitFor();
      assert.deepEqual(await contactLines(e), []);
      await converge(a, d);
      await e.keyboard.press("Escape");
      // The member set of a file never changes: the shared file still syncs.
      await setBody(a, noteK, (await noteBody(a, noteK)) + "\n\nafter the contact was removed");
      await convergeShared([a, e], a, d, e);
      assert.match(await noteBody(e, noteK), /after the contact was removed$/);
    });

    await step("the admin page signs in with the device's keys (a server that doesn't know the identity says so)", async () => {
      const page = await a.context().newPage();
      try {
        await page.goto(`http://127.0.0.1:${PORT}/app/admin/`);
        await page.locator(".adm-state h2", { hasText: "is not an admin of" }).waitFor();
      } finally {
        await page.close();
      }
    });

    await step("the owner's news reach every device: seen on one is seen on all, an archived post goes with its marker", async () => {
      await converge(a, d);
      const admin = await startAdminServer(await ident(a));
      try {
        const made = await adminCall(a, "POST", "/v1/admin/news", JSON.stringify({ body: sampleNews.p03 }));
        assert.equal(made.status, 201, made.body);
        const { id } = JSON.parse(made.body);
        const news = p => p.evaluate(() => window.__store.newsNotes().map(n => ({ id: n.id, body: n.body, fresh: n.fresh, status: n.status })));
        await converge(a, d);
        for (const p of [a, d]) assert.deepEqual(await news(p), [{ id, body: sampleNews.p03, fresh: "new", status: "open" }], p.label + " has the new post");
        await a.evaluate(i => window.__store.markNewsSeen([i]), id);
        await converge(a, d);
        assert.equal((await news(d))[0].fresh, null, "seen on A, seen on D");
        assert.match(await fileText(d), new RegExp(`<!-- news id=${id} seen=\\S+ -->`));
        const edited = await adminCall(a, "PUT", `/v1/admin/news/${id}`, JSON.stringify({ body: sampleNews.p03 + "\n\n" + sampleNews.p02 }));
        assert.equal(edited.status, 204, edited.body);
        await converge(a, d);
        assert.equal((await news(d))[0].fresh, "updated", "an edited post is updated again");
        assert.equal((await adminCall(a, "PUT", `/v1/admin/news/${id}`, JSON.stringify({ archived: true }))).status, 204);
        await converge(a, d);
        for (const p of [a, d]) assert.deepEqual(await news(p), [], p.label + " no longer shows the archived post");
        assert.doesNotMatch(await fileText(a), /<!-- news /, "its marker left the private file");
      } finally {
        await stopAdminServer(admin);
      }
    });

    await step("a restored server loses no note: backup, both of Sam's devices edit on, restore, sync; the device list gets back what it lost", async () => {
      await tidy(a);
      await converge(a, d);
      await convergeShared([a, e], a, d, e);
      const admin = await startAdminServer(await ident(a));
      try {
        assert.equal((await adminCall(d, "GET", "/v1/admin/overview")).status, 200, "every device of the admin identity is the admin");
        const overview = await adminCall(a, "GET", "/v1/admin/overview");
        assert.equal(overview.status, 200);
        assert.ok(JSON.parse(overview.body).counts.identities >= 3);
        const backup = await adminCall(a, "GET", "/v1/admin/backup");
        assert.equal(backup.status, 200);
        const epoch = async p => (await p.evaluate(() => Object.values(window.__store.state.sync.epochs)))[0] || null;
        assert.equal(await epoch(a), null, "no restore yet");

        // Both devices edit on: a new note each, an edit to a shared note, so the server moves past the backup.
        await addNote(a, sample.s14);
        await addNote(d, sample.s15);
        await setBody(d, noteK, (await noteBody(d, noteK)) + "\n\nafter the backup");
        await converge(a, d);
        await convergeShared([a, e], a, d, e);
        // H joins with the recovery key after the backup: the restored device list won't have it. Its page is
        // closed until A and D have put the list back (signing in before that, it would count as removed).
        let h = await device(browser, "H", { width: 1440, height: 900 });
        await h.evaluate(k => window.__sync.restore(k), key);
        await converge(a, d, h);
        const hDevice = (await syncState(h)).device;
        const hContext = h.context();
        await h.close();
        const expected = await bodies(a);
        assert.ok(expected.includes(sample.s14) && expected.includes(sample.s15));

        const restored = await adminCall(a, "POST", "/v1/admin/restore", backup.body);
        assert.equal(restored.status, 200, restored.body);

        // The first sync after the restore: nothing lost, nobody sees an "older version" error, both converge.
        for (const p of [a, d]) {
          await sync(p);
          assert.equal((await syncState(p)).status, "synced", (await syncState(p)).error);
        }
        // A's and D's device lists were longer than the restored one: they appended what it lacked, H is back.
        assert.equal(await a.evaluate(async id => (await window.__sync.loadDevices()).get(id)?.active, hDevice), true, "H is on the list again");
        h = await hContext.newPage();
        h.on("pageerror", err => errors.push(`H: ${err.message}`));
        await h.goto(`http://127.0.0.1:${PORT}/app/index.html?api=${API}`);
        await h.waitForFunction(() => document.body.dataset.ready === "1");
        await loadModules(h);
        await sync(h);
        assert.equal((await syncState(h)).status, "synced", (await syncState(h)).error);
        await h.context().close();
        await converge(a, d);
        const after = await bodies(a);
        for (const b of expected) assert.ok(after.includes(b), "a note survived the restore on A: " + b.slice(0, 30));
        for (const b of await bodies(d)) assert.ok(after.includes(b), "the same notes on D");
        assert.ok((await epoch(a)) && (await epoch(a)) === (await epoch(d)), "both remember the server's new epoch");
        // The shared file too, with Lea's device joining in.
        await convergeShared([a, e], a, d, e);
        assert.match(await noteBody(a, noteK), /after the backup$/, "the shared note keeps the edit made after the backup (a note edited on both sides gets a conflict copy)");
        assert.match(await noteBody(e, noteK), /after the backup$/);
        // Later changes go on as usual.
        await addNote(d, sample.s16);
        await converge(a, d);
        assert.ok((await bodies(a)).includes(sample.s16));
      } finally {
        await stopAdminServer(admin);
      }
    });

    await step("version history: kept once the owner switches it on, readable after a key renewal, a restore brings a state back on every device, \"Back up now\" keeps the current one", async () => {
      await converge(a, d);
      const admin = await startAdminServer(await ident(a));
      try {
        const on = await adminCall(a, "PUT", `/v1/admin/identities/${await ident(a)}/history`, JSON.stringify({ history: true }));
        assert.equal(on.status, 204, on.body);
        await sync(a);
        assert.ok((await syncState(a)).history.includes(""), "the private file keeps a history (the shared ones too)");
        const before = (await bodies(a)).sort();
        await addNote(a, sample.s17);
        await converge(a, d);
        const versions = p => p.evaluate(() => window.__sync.fileVersions(""));
        const textOf = (p, v) => p.evaluate(v => window.__sync.fileVersionText("", v), v);
        const notesOf = text => [...text.matchAll(/^<!-- note [^\n]*-->\n([\s\S]*?)(?=\n<!-- |$)/gm)].length;
        const listed = await versions(a);
        const oldest = listed.at(-1);
        assert.ok(oldest && !oldest.pinned, "the state before the new note is kept");
        assert.ok(!(await textOf(a, oldest.version)).includes(sample.s17), "it is the state before the note");
        assert.ok(notesOf(await textOf(a, oldest.version)) > 0);
        // A renewed file key (as after removing a device) keeps the older states readable, on both devices.
        await a.evaluate(async () => { (await import("/app/js/sync/files.js")).markRenew(); await window.__sync.syncNow(); });
        assert.deepEqual((await stateOf(a)).renew, [], "renewed");
        await converge(a, d);
        assert.equal(await textOf(d, oldest.version), await textOf(a, oldest.version), "D reads it through the key chain");
        // Restoring brings the old notes back on both devices; the state it replaced stays, pinned.
        await a.evaluate(v => window.__sync.restoreFileVersion("", v), oldest.version);
        await converge(a, d);
        for (const p of [a, d]) assert.deepEqual((await bodies(p)).sort(), before, p.label + " has the restored notes");
        const pinned = (await versions(d)).find(v => v.pinned);
        assert.ok(pinned, "the replaced state is pinned");
        assert.ok((await textOf(d, pinned.version)).includes(sample.s17));
        // And undoing the restore from the other device brings the note back.
        await d.evaluate(v => window.__sync.restoreFileVersion("", v), pinned.version);
        await converge(a, d);
        assert.ok((await bodies(a)).includes(sample.s17), "undone");
        // "Back up now" keeps the current state of every file with a history, once until the next change.
        const saved = await a.evaluate(() => window.__sync.backUpNow());
        assert.equal(saved, (await syncState(a)).history.length, "one new state per file");
        assert.equal(await a.evaluate(() => window.__sync.backUpNow()), 0, "unchanged: nothing new");
        const backup = (await versions(d)).find(v => v.saved);
        assert.ok(backup && backup.pinned, "D lists the backup, pinned");
        assert.ok((await textOf(d, backup.version)).includes(sample.s17), "it holds the notes as they are now");
        const off = await adminCall(a, "PUT", `/v1/admin/identities/${await ident(a)}/history`, JSON.stringify({ history: false }));
        assert.equal(off.status, 204, off.body);
        await sync(a);
        assert.deepEqual((await syncState(a)).history, [], "switched off: no history");
        assert.deepEqual(await versions(a), [], "the stored states are gone");
      } finally {
        await stopAdminServer(admin);
      }
    });

    await step("Lea signs out her only device and restores it with the recovery key: the keys her device signed still count, and are renewed at once", async () => {
      await convergeShared([a, e], a, d, e);
      const before = (await bodies(e)).sort();
      // The key generation of Lea's private file: only her signed-out device vouches for it after the restore.
      const generation = page => page.evaluate(async () => {
        const r = window.__store.state.sync.file;
        return window.__keystore.getSecret("filegen:" + r.server + "/" + r.id);
      });
      const genBefore = await generation(e);
      await openPanel(e);
      await e.getByRole("button", { name: "Sign out this device" }).click();
      await Promise.all([
        e.waitForNavigation(),
        e.getByRole("button", { name: "Sign out and erase", exact: true }).click(),
      ]);
      // The test's server address was erased with the rest; the real app has its server built in.
      await e.goto(`http://127.0.0.1:${PORT}/app/index.html?api=${API}`);
      await e.waitForFunction(() => document.body.dataset.ready === "1");
      await loadModules(e);
      await openPanel(e);
      await e.getByRole("button", { name: "Link to an existing device" }).click();
      await e.fill("#syncBody input", e.recoveryKey);
      await e.getByRole("button", { name: "Restore" }).click();
      await e.getByText("This device", { exact: true }).waitFor();
      await e.keyboard.press("Escape");
      await convergeShared([a, e], a, d, e);
      assert.deepEqual((await bodies(e)).sort(), before, "every note of Lea's comes back");
      assert.deepEqual((await syncState(e)).renew, [], "renewed");
      assert.equal(await generation(e), genBefore + 1, "a key a signed-out device signed is renewed (security review H4)");
    });

    await step("the owner blocks Lea until a day and lifts it; Lea deletes her sync data with the recovery key and keeps her notes, Sam keeps the shared one", async () => {
      await convergeShared([a, e], a, d, e);
      const lea = await ident(e);
      const admin = await startAdminServer(await ident(a));
      try {
        const until = new Date(Date.now() + 3 * 86400000).toISOString();
        const blocked = await adminCall(a, "PUT", `/v1/admin/identities/${lea}/block`, JSON.stringify({ blocked: true, until }));
        assert.equal(blocked.status, 204, blocked.body);
        await sync(e);
        assert.match((await syncState(e)).error, /^Sync is blocked by the server's owner until \d+ \w+ \d{4}\.$/);
        await e.locator("#syncNotice", { hasText: "Sync is blocked by the server's owner until" }).waitFor();
        await setBody(a, noteK, (await noteBody(a, noteK)) + "\n\nwhile Lea is blocked");
        await sync(a);
        assert.equal((await syncState(a)).status, "synced", "a block doesn't stop the others");
        const lifted = await adminCall(a, "PUT", `/v1/admin/identities/${lea}/block`, JSON.stringify({ blocked: false }));
        assert.equal(lifted.status, 204, lifted.body);
        await convergeShared([a, e], a, d, e);
        assert.equal(await e.locator("#syncNotice").isHidden(), true, "the card goes once the block is lifted");
      } finally {
        await stopAdminServer(admin);
      }
      const leaNotes = (await bodies(e)).sort();
      await openPanel(e);
      await e.getByRole("button", { name: "Delete sync data" }).click();
      await e.fill('#syncBody input[aria-label="Recovery key"]', e.recoveryKey);
      await e.getByRole("button", { name: "Delete for good" }).click();
      await e.getByText("Your sync data was deleted from the server.", { exact: false }).waitFor();
      await shot(e, "deleted-desktop");
      assert.equal((await syncState(e)).enabled, false);
      assert.deepEqual((await bodies(e)).sort(), leaNotes, "Lea keeps every note, the shared one as a private note");
      await e.keyboard.press("Escape");
      await sync(a);
      assert.equal((await syncState(a)).status, "synced", (await syncState(a)).error);
      assert.deepEqual((await syncState(a)).deleted, [lea], "Sam's device knows Lea is deleted");
      assert.match(await noteBody(a, noteK), /while Lea is blocked$/, "Sam keeps the shared note");
      await setBody(a, noteK, (await noteBody(a, noteK)) + "\n\nafter Lea deleted her data");
      await converge(a, d);
      assert.equal((await syncState(a)).status, "synced", (await syncState(a)).error);
      assert.match(await noteBody(d, noteK), /after Lea deleted her data$/);
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

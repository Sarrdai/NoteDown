// Unit tests for the admin dashboard's logic (app/js/core/admin.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  formatBytes, megabytes, usageText, meterText, shortId, usageLevel, plural, formatDate, cardMeta, fileScope,
  sortIdentities, filterIdentities, defaultDirection, parseQuotaInput, quotaInputText, readBackup, backupSummaryText, restoreErrorText,
  backupFileName, sampleBackup, createSampleAdmin, MB, BACKUP_TABLES, OPTIONAL_BACKUP_TABLES, MAX_NEWS_BODY,
  MAX_NEWS_PUBLISHED, NEW_POST_TEXT, checkNewsBody, newsErrorText, newsTime, newsDateText, splitNews, newsFromNotes, blockText, parseBlockUntil,
} from "../app/js/core/admin.js";
import { parseNotesFile } from "../app/js/core/notes-file.js";

const sample = JSON.parse(readFileSync(new URL("../app/sample/admin.json", import.meta.url), "utf8"));

test("formatBytes picks B, KB, MB or GB", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(812), "812 B");
  assert.equal(formatBytes(8192), "8 KB");
  assert.equal(formatBytes(75000), "73.2 KB");
  assert.equal(formatBytes(1.7 * MB), "1.7 MB");
  assert.equal(formatBytes(512 * MB), "512 MB");
  assert.equal(formatBytes(2048 * MB), "2 GB");
});

test("usage texts count in MB like the app's storage bar", () => {
  assert.equal(megabytes(0), "0");
  assert.equal(megabytes(1000), "< 0.1");
  assert.equal(megabytes(314572), "0.3");
  assert.equal(usageText(314572, 2 * MB), "0.3 of 2 MB");
  assert.equal(usageText(0, 10 * MB), "0 of 10 MB");
  assert.equal(meterText(9856614, 512 * MB), "9.4 MB of 512 MB");
});

test("shortId keeps the first 8 characters", () => {
  assert.equal(shortId("SHJp3Uwrq1jG4IEXjnNNkg"), "SHJp3Uwr");
  assert.equal(shortId("abc"), "abc");
});

test("usageLevel: ok, warning from 80 %, full at 100 %", () => {
  assert.deepEqual(usageLevel(0, 100), { fraction: 0, percent: 0, level: "ok" });
  assert.equal(usageLevel(79, 100).level, "ok");
  assert.equal(usageLevel(80, 100).level, "warning");
  assert.equal(usageLevel(99, 100).level, "warning");
  assert.equal(usageLevel(100, 100).level, "full");
  assert.deepEqual(usageLevel(150, 100), { fraction: 1, percent: 100, level: "full" });
  assert.equal(usageLevel(5, 0).level, "full");
});

test("plural and fileScope", () => {
  assert.equal(plural(1, "device"), "1 device");
  assert.equal(plural(0, "file"), "0 files");
  assert.equal(fileScope(["a"]), "Private");
  assert.equal(fileScope(["a", "b", "c"]), "Shared · 3 people");
});

test("formatDate", () => {
  assert.equal(formatDate("2026-10-14T09:12:00Z", { timeZone: "UTC" }), "14 Oct 2026");
  assert.equal(formatDate("2026-10-14T09:12:00Z", { time: true, timeZone: "UTC" }), "14 Oct 2026, 09:12");
  assert.equal(formatDate("2026-10-14T23:30:00Z", { timeZone: "Asia/Tokyo" }), "15 Oct 2026");
  assert.equal(formatDate(null), "—");
  assert.equal(formatDate("nonsense"), "nonsense");
});

test("cardMeta", () => {
  const fmt = d => (d ? "14 Oct" : "—");
  assert.equal(cardMeta({ devices: 2, files: 3, updated: "x" }, fmt), "2 devices · 3 files · last change 14 Oct");
  assert.equal(cardMeta({ devices: 1, files: 0, updated: null }, fmt), "1 device · 0 files · last change —");
});

const ids = [
  { id: "b", created: "2026-08-01", devices: 2, files: 3, used: 10, updated: "2026-10-02", contacts: 1 },
  { id: "a", created: "2026-09-01", devices: 1, files: 0, used: 0, updated: null, contacts: 0 },
  { id: "c", created: "2026-07-01", devices: 2, files: 1, used: 30, updated: "2026-10-09", contacts: 1 },
];

test("sortIdentities: last change newest first by default, no change last", () => {
  assert.deepEqual(sortIdentities(ids).map(i => i.id), ["c", "b", "a"]);
  assert.deepEqual(sortIdentities(ids, "updated", "asc").map(i => i.id), ["b", "c", "a"]);
});

test("sortIdentities: other columns, ties by ID, input untouched", () => {
  assert.deepEqual(sortIdentities(ids, "created").map(i => i.id), ["a", "b", "c"]);
  assert.deepEqual(sortIdentities(ids, "id").map(i => i.id), ["a", "b", "c"]);
  assert.deepEqual(sortIdentities(ids, "devices").map(i => i.id), ["b", "c", "a"]);
  assert.deepEqual(sortIdentities(ids, "used", "asc").map(i => i.id), ["a", "b", "c"]);
  assert.deepEqual(ids.map(i => i.id), ["b", "a", "c"]);
  assert.equal(defaultDirection("id"), "asc");
  assert.equal(defaultDirection("files"), "desc");
});

test("parseQuotaInput: MB to bytes, empty = default, bounds 1 byte .. 1 GiB", () => {
  assert.deepEqual(parseQuotaInput(""), { quota: null });
  assert.deepEqual(parseQuotaInput("   "), { quota: null });
  assert.deepEqual(parseQuotaInput("10"), { quota: 10 * MB });
  assert.deepEqual(parseQuotaInput("0.5"), { quota: MB / 2 });
  assert.deepEqual(parseQuotaInput("2,5"), { quota: 2.5 * MB });
  assert.deepEqual(parseQuotaInput("1024"), { quota: 1024 * MB });
  assert.deepEqual(parseQuotaInput("0.000001"), { quota: 1 });
  assert.match(parseQuotaInput("1025").error, /at most 1024 MB/);
  assert.match(parseQuotaInput("0").error, /at least 1 byte/);
  assert.match(parseQuotaInput("0.0000001").error, /at least 1 byte/);
  assert.match(parseQuotaInput("-3").error, /number of MB/);
  assert.match(parseQuotaInput("abc").error, /number of MB/);
  assert.match(parseQuotaInput("1e3").error, /number of MB/);
});

test("quotaInputText", () => {
  assert.equal(quotaInputText(null), "");
  assert.equal(quotaInputText(10 * MB), "10");
  assert.equal(quotaInputText(MB / 2), "0.5");
});

const backup = () => ({
  format: "notedown-backup", version: 1, created: "2026-10-14T09:12:00Z",
  tables: { identities: [{ id: "a" }, { id: "b" }], device_entries: [], files: [{ id: "f" }], file_members: [], file_keys: [], contacts: [], invitations: [] },
});

test("readBackup returns the summary of a valid backup", () => {
  const r = readBackup(JSON.stringify(backup()));
  assert.deepEqual(r.summary, { created: "2026-10-14T09:12:00Z", identities: 2, files: 1 });
  assert.equal(r.backup.version, 1);
  assert.equal(backupSummaryText(r.summary, d => d.slice(0, 10)), "Backup from 2026-10-14: 2 identities, 1 file");
  assert.equal(backupSummaryText({ created: null, identities: 1, files: 0 }), "Backup from an unknown date: 1 identity, 0 files");
});

test("readBackup names what is wrong", () => {
  assert.match(readBackup("not json").error, /not valid JSON/);
  assert.match(readBackup("[]").error, /not a NoteDown backup/);
  assert.match(readBackup("null").error, /not a NoteDown backup/);
  assert.match(readBackup(JSON.stringify({ ...backup(), format: "other" })).error, /not a NoteDown backup/);
  assert.match(readBackup(JSON.stringify({ ...backup(), version: 2 })).error, /unsupported version \(2\)/);
  assert.match(readBackup(JSON.stringify({ ...backup(), tables: undefined })).error, /no tables/);
  const missing = backup();
  delete missing.tables.file_keys;
  assert.match(readBackup(JSON.stringify(missing)).error, /missing the table "file_keys"/);
  const notList = backup();
  notList.tables.contacts = {};
  assert.match(readBackup(JSON.stringify(notList)).error, /missing the table "contacts"/);
});

test("restoreErrorText", () => {
  assert.match(restoreErrorText(409, { detail: "the backup would lock you out" }), /lock you out/);
  assert.match(restoreErrorText(400, { detail: "invalid device chain" }), /: invalid device chain$/);
  assert.match(restoreErrorText(413, null), /too large/);
  assert.equal(restoreErrorText(500, null), null);
});

test("backupFileName follows Content-Disposition, else the date", () => {
  const now = new Date("2026-10-15T08:00:00Z");
  assert.equal(backupFileName('attachment; filename="notedown-backup-2026-10-15-0800.json"', now), "notedown-backup-2026-10-15-0800.json");
  assert.equal(backupFileName("attachment; filename=x.json", now), "x.json");
  assert.equal(backupFileName('attachment; filename="../evil/x.json"', now), "..evilx.json");
  assert.equal(backupFileName("", now), "notedown-backup-2026-10-15.json");
  assert.equal(backupFileName(null, now), "notedown-backup-2026-10-15.json");
});

test("the sample is consistent with the API contract", () => {
  const { overview, identities, details } = sample;
  assert.equal(overview.counts.identities, identities.length);
  assert.equal(overview.counts.devices, identities.reduce((n, i) => n + i.devices, 0));
  const files = new Map();
  for (const d of Object.values(details)) for (const f of d.files) files.set(f.id, f);
  assert.equal(overview.counts.files, files.size);
  assert.equal(overview.counts.shared_files, [...files.values()].filter(f => f.members.length > 1).length);
  assert.equal(overview.storage.files, [...files.values()].reduce((n, f) => n + f.size, 0));
  for (const i of identities) {
    assert.match(i.id, /^[A-Za-z0-9_-]{22}$/);
    const d = details[i.id];
    assert.equal(i.files, d.files.length);
    assert.equal(i.used, d.files.reduce((n, f) => n + f.size, 0));
    assert.equal(i.contacts, d.contacts.length);
    assert.equal(i.devices, d.devices.filter(x => x.kind === "device" && x.active).length);
    assert.equal(i.quota, i.quota_override ?? overview.quota);
  }
  assert.ok(identities.some(i => usageLevel(i.used, i.quota).level === "warning"));
  assert.ok(identities.some(i => i.quota_override === 10 * MB));
  assert.ok(identities.some(i => i.files === 0 && i.updated === null));
  assert.ok(Object.values(details).some(d => d.devices.some(x => !x.active)));
  assert.ok(Object.values(details).some(d => d.devices.some(x => x.kind === "recovery")));
  assert.ok(identities.some(i => i.id === overview.identity));
});

test("the sample server sets and resets a storage limit", async () => {
  const api = createSampleAdmin(sample);
  const id = sample.identities[0].id;
  await api.adminSetQuota(id, 5 * MB);
  let d = await api.adminIdentity(id);
  assert.equal(d.quota, 5 * MB);
  assert.equal(d.quota_override, 5 * MB);
  assert.equal((await api.adminIdentities()).identities.find(i => i.id === id).quota_override, 5 * MB);
  await api.adminSetQuota(id, null);
  d = await api.adminIdentity(id);
  assert.equal(d.quota_override, null);
  assert.equal(d.quota, sample.overview.quota);
  await assert.rejects(() => api.adminSetQuota(id, 0), { status: 400 });
  await assert.rejects(() => api.adminSetQuota(id, 1025 * MB), { status: 400 });
  await assert.rejects(() => api.adminIdentity("nobody"), { status: 404 });
  assert.equal(sample.identities[0].quota_override, null, "the sample file is not changed");
});

test("the sample backup passes the validator and restores the sample", async () => {
  const api = createSampleAdmin(sample);
  const { text, filename } = await api.adminBackup(new Date("2026-10-15T08:00:00Z"));
  assert.equal(filename, "notedown-backup-2026-10-15.json");
  const r = readBackup(text);
  assert.deepEqual(r.summary, { created: "2026-10-15T08:00:00.000Z", identities: 6, files: 8 });
  const id = sample.identities[0].id;
  await api.adminSetQuota(id, 3 * MB);
  assert.deepEqual(await api.adminRestore(r.backup), { identities: 6, files: 8 });
  assert.equal((await api.adminIdentity(id)).quota_override, null, "the restore brought the old limit back");
  assert.equal(sampleBackup(sample).tables.file_members.length, 12);
});

// ---------- news ----------

const samplePosts = newsFromNotes(parseNotesFile(readFileSync(new URL("../app/sample/news.md", import.meta.url), "utf8")).notes);

test("the sample posts come from app/sample/news.md", () => {
  assert.equal(samplePosts.length, 3);
  assert.deepEqual(samplePosts.map(p => p.id), ["p03", "p02", "p01"]);
  assert.ok(samplePosts.every(p => !p.archived && p.body.startsWith("## ") && p.created && p.modified));
  assert.notEqual(samplePosts[1].created, samplePosts[1].modified, "one of them was edited");
});

test("checkNewsBody trims, refuses an empty text and more than 16 KB", () => {
  assert.deepEqual(checkNewsBody("  ## Hello \n"), { body: "## Hello" });
  assert.match(checkNewsBody("").error, /needs some text/);
  assert.match(checkNewsBody(" \n\t").error, /needs some text/);
  assert.match(checkNewsBody(null).error, /needs some text/);
  assert.match(checkNewsBody("x".repeat(MAX_NEWS_BODY + 1)).error, /16 KB/);
  assert.equal(checkNewsBody("x".repeat(MAX_NEWS_BODY)).body.length, MAX_NEWS_BODY);
  assert.match(checkNewsBody("é".repeat(MAX_NEWS_BODY / 2 + 1)).error, /16 KB/, "counted in UTF-8 bytes");
  assert.equal(NEW_POST_TEXT, "## ");
});

test("news dates and error sentences", () => {
  assert.equal(newsTime("2026-10-15T09:00:12.345678+00:00"), "2026-10-15T09:00Z");
  assert.equal(newsTime("nonsense"), "");
  const rel = ts => (ts === "2026-10-15T09:00Z" ? "Today 09:00" : ts === "2026-10-14T16:00Z" ? "Yesterday 16:00" : "12 Oct");
  const post = { created: "2026-10-14T16:00:00+00:00", modified: "2026-10-14T16:00:00+00:00" };
  assert.equal(newsDateText(post, rel), "Published yesterday 16:00");
  assert.equal(newsDateText({ ...post, modified: "2026-10-15T09:00:00+00:00" }, rel), "Published yesterday 16:00 · Edited today 09:00");
  assert.equal(newsDateText({ created: "2026-10-01T09:00Z", modified: "2026-10-01T09:00Z" }, () => "12 Oct"), "Published 12 Oct");
  assert.equal(newsErrorText(409, { detail: "too many news" }), "At most 20 posts can be published. Archive one first.");
  assert.equal(newsErrorText(404, { detail: "unknown news" }), "This post no longer exists.");
  assert.equal(newsErrorText(500, null), null);
  assert.equal(newsErrorText(409, { detail: "version conflict" }), null);
});

test("splitNews: published and archived, each newest first", () => {
  const posts = [
    { id: "a", created: "2026-10-01T09:00Z", archived: false }, { id: "b", created: "2026-10-03T09:00Z", archived: true },
    { id: "c", created: "2026-10-02T09:00Z", archived: false }, { id: "d", created: "2026-10-04T09:00Z", archived: true },
  ];
  const { published, archived } = splitNews(posts);
  assert.deepEqual(published.map(p => p.id), ["c", "a"]);
  assert.deepEqual(archived.map(p => p.id), ["d", "b"]);
  assert.deepEqual(posts.map(p => p.id), ["a", "b", "c", "d"], "the input keeps its order");
});

test("the sample server keeps news in memory like the real one", async () => {
  const api = createSampleAdmin(sample, samplePosts);
  assert.deepEqual((await api.adminNews()).news.map(p => p.id), ["p03", "p02", "p01"]);
  assert.equal((await api.adminOverview()).counts.news, 3);

  const t1 = new Date("2026-10-15T10:00:00Z"), t2 = new Date("2026-10-15T11:00:00Z");
  const made = await api.adminCreateNews("  ## Fresh  ", t1);
  assert.deepEqual(made, { id: made.id, created: t1.toISOString(), modified: t1.toISOString() });
  let posts = (await api.adminNews()).news;
  assert.equal(posts[0].id, made.id, "newest first");
  assert.equal(posts[0].body, "## Fresh");
  assert.equal((await api.adminOverview()).counts.news, 4);

  // modified moves with a different body only, not with an identical one or archiving.
  await api.adminUpdateNews(made.id, { body: "## Fresh" }, t2);
  await api.adminUpdateNews(made.id, { archived: true }, t2);
  await api.adminUpdateNews(made.id, { archived: false }, t2);
  assert.equal((await api.adminNews()).news[0].modified, t1.toISOString());
  await api.adminUpdateNews(made.id, { body: "## Fresher", archived: true }, t2);
  const edited = (await api.adminNews()).news.find(p => p.id === made.id);
  assert.deepEqual([edited.body, edited.archived, edited.modified, edited.created], ["## Fresher", true, t2.toISOString(), t1.toISOString()]);
  assert.equal((await api.adminOverview()).counts.news, 3, "archived posts are not counted");

  await api.adminDeleteNews(made.id);
  await api.adminDeleteNews(made.id);
  assert.deepEqual((await api.adminNews()).news.map(p => p.id), ["p03", "p02", "p01"]);
  assert.equal(samplePosts.length, 3, "the given posts are not changed");
});

test("the sample server refuses what the real one refuses", async () => {
  const api = createSampleAdmin(sample, samplePosts);
  await assert.rejects(() => api.adminCreateNews("  "), { status: 400 });
  await assert.rejects(() => api.adminCreateNews("x".repeat(MAX_NEWS_BODY + 1)), { status: 400 });
  await assert.rejects(() => api.adminUpdateNews("p01", {}), { status: 400 });
  await assert.rejects(() => api.adminUpdateNews("p01", { archived: "yes" }), { status: 400 });
  await assert.rejects(() => api.adminUpdateNews("p01", { body: "" }), { status: 400 });
  await assert.rejects(() => api.adminUpdateNews("nobody", { archived: true }), { status: 404 });
  // At most 20 published: fill up, then neither a new post nor publishing an archived one fits.
  while ((await api.adminNews()).news.filter(p => !p.archived).length < MAX_NEWS_PUBLISHED) await api.adminCreateNews("## More");
  await assert.rejects(() => api.adminCreateNews("## One too many"), { status: 409, body: { detail: "too many news" } });
  await api.adminUpdateNews("p01", { archived: true });
  await api.adminCreateNews("## Takes the room");
  await assert.rejects(() => api.adminUpdateNews("p01", { archived: false }), { status: 409, body: { detail: "too many news" } });
  await api.adminUpdateNews("p02", { body: "## Edited at the limit" });
  await api.adminUpdateNews("p02", { archived: false });
});

test("the sample backup holds the news and a restore brings them back", async () => {
  const api = createSampleAdmin(sample, samplePosts);
  await api.adminUpdateNews("p01", { archived: true });
  const { text } = await api.adminBackup(new Date("2026-10-15T08:00:00Z"));
  const r = readBackup(text);
  assert.deepEqual(r.backup.tables.news.map(n => [n.id, n.archived]), [["p03", false], ["p02", false], ["p01", true]]);
  assert.deepEqual(Object.keys(r.backup.tables.news[0]).sort(), ["archived", "body", "created", "id", "modified"]);
  await api.adminDeleteNews("p03");
  await api.adminCreateNews("## New");
  await api.adminRestore(r.backup);
  assert.deepEqual((await api.adminNews()).news.map(p => [p.id, p.archived]), [["p03", false], ["p02", false], ["p01", true]]);
});

test("readBackup: the news table is optional but must be a list", () => {
  const old = backup();
  assert.ok(!("news" in old.tables) || Array.isArray(old.tables.news));
  delete old.tables.news;
  assert.ok(readBackup(JSON.stringify(old)).backup, "a backup from before news restores");
  const withNews = backup();
  withNews.tables.news = [];
  assert.ok(readBackup(JSON.stringify(withNews)).backup);
  withNews.tables.news = {};
  assert.match(readBackup(JSON.stringify(withNews)).error, /"news" of the backup is not a list/);
  assert.ok(BACKUP_TABLES.every(t => t !== "news") && OPTIONAL_BACKUP_TABLES.includes("news"));
});

test("filterIdentities matches a part of the full ID, case-insensitive, white space ignored", () => {
  const list = [{ id: "SHJp3Uwrq1jG4IEXjnNNkg" }, { id: "gTJenhuklXInO6uthC2Adp" }, { id: "h6-mlUtIjaWLGGX3o6ywKk" }];
  const ids = q => filterIdentities(list, q).map(i => i.id);
  assert.deepEqual(ids("shjp3"), ["SHJp3Uwrq1jG4IEXjnNNkg"]);
  assert.deepEqual(ids("  HJP3uw "), ["SHJp3Uwrq1jG4IEXjnNNkg"]);
  assert.deepEqual(ids("jg4iexjnnnkg".slice(0, 4)), ["SHJp3Uwrq1jG4IEXjnNNkg"], "any part, not only the start");
  assert.deepEqual(ids("SHJp3Uwrq1jG4IEXjnNNkg"), ["SHJp3Uwrq1jG4IEXjnNNkg"], "a full ID");
  assert.deepEqual(ids("tj"), ["gTJenhuklXInO6uthC2Adp"]);
  assert.deepEqual(ids("zzz"), []);
  assert.deepEqual(ids("h"), list.map(i => i.id), "the original order is kept");
});

test("filterIdentities: an empty query keeps all, as a new array", () => {
  const list = [{ id: "a1" }, { id: "b2" }];
  for (const q of ["", "   ", null, undefined]) {
    const out = filterIdentities(list, q);
    assert.deepEqual(out, list);
    assert.notEqual(out, list);
  }
});

test("the sample server switches the version history of an identity", async () => {
  const api = createSampleAdmin(sample);
  const id = sample.identities.find(i => !i.history && sample.details[i.id].files.length).id;
  assert.equal((await api.adminIdentity(id)).history, false);
  const before = (await api.adminOverview()).storage.history;
  await api.adminSetHistory(id, true);
  const d = await api.adminIdentity(id);
  assert.equal(d.history, true);
  assert.ok(d.history_size > 0);
  assert.equal((await api.adminIdentities()).identities.find(i => i.id === id).history, true);
  assert.equal((await api.adminOverview()).storage.history, before + d.history_size);
  await api.adminSetHistory(id, false);
  assert.equal((await api.adminIdentity(id)).history, false);
  assert.equal((await api.adminOverview()).storage.history, before);
  await assert.rejects(() => api.adminSetHistory("nope", true), { status: 404 });
  await assert.rejects(() => api.adminSetHistory(id, "yes"), { status: 400 });
});

test("the sample data carries the history fields", () => {
  const on = sample.identities.filter(i => i.history);
  assert.ok(on.length >= 1);
  for (const i of sample.identities) {
    assert.equal(typeof i.history, "boolean");
    assert.equal(sample.details[i.id].history, i.history);
  }
  assert.equal(sample.overview.storage.history, on.reduce((n, i) => n + sample.details[i.id].history_size, 0));
});

test("blockText and parseBlockUntil", () => {
  assert.equal(blockText(null), "Blocked");
  assert.equal(blockText("2026-10-25T00:00:00Z", d => formatDate(d, { timeZone: "UTC" })), "Blocked until 25 Oct 2026");
  const now = new Date(2026, 9, 16, 15, 0);
  const r = parseBlockUntil("2026-10-25", now);
  assert.equal(new Date(r.until).getTime(), new Date(2026, 9, 25).getTime());   // the start of that day, local time
  assert.match(parseBlockUntil("", now).error, /Pick the day/);
  assert.match(parseBlockUntil("2026-10-16", now).error, /after today/);
  assert.match(parseBlockUntil("25.10.2026", now).error, /Pick the day/);
});

test("the sample data carries the block fields, one identity blocked", () => {
  for (const i of sample.identities) assert.ok("blocked" in i && "blocked_until" in i);
  assert.equal(sample.overview.counts.blocked, sample.identities.filter(i => i.blocked).length);
  assert.ok(sample.identities.some(i => i.blocked && i.blocked_until));
});

test("the sample server blocks, lifts and deletes like the real one", async () => {
  const admin = createSampleAdmin(sample);
  const own = sample.overview.identity;
  const shared = Object.values(sample.details).flatMap(d => d.files).find(f => f.members.length > 1);
  const [victim, keeper] = shared.members.filter(m => m !== own);
  await admin.adminBlock(victim, true, null);
  assert.equal((await admin.adminIdentity(victim)).blocked, true);
  assert.equal((await admin.adminOverview()).counts.blocked, sample.identities.filter(i => i.blocked).length + (sample.identities.find(i => i.id === victim).blocked ? 0 : 1));
  await admin.adminBlock(victim, false);
  assert.equal((await admin.adminIdentity(victim)).blocked_until, null);
  await assert.rejects(admin.adminBlock(own, true), e => e.status === 409);
  await assert.rejects(admin.adminDeleteIdentity(own), e => e.status === 409);
  const before = await admin.adminOverview();
  await admin.adminDeleteIdentity(victim);
  await assert.rejects(admin.adminIdentity(victim), e => e.status === 404);
  const after = await admin.adminOverview();
  assert.equal(after.counts.identities, before.counts.identities - 1);
  assert.ok((await admin.adminIdentities()).identities.every(i => i.id !== victim));
  if (keeper) assert.ok((await admin.adminIdentity(keeper)).files.some(f => f.id === shared.id));   // shared files stay
});

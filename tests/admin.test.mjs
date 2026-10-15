// Unit tests for the admin dashboard's logic (app/js/core/admin.js). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  formatBytes, megabytes, usageText, meterText, shortId, usageLevel, plural, formatDate, cardMeta, fileScope,
  sortIdentities, defaultDirection, parseQuotaInput, quotaInputText, readBackup, backupSummaryText, restoreErrorText,
  backupFileName, sampleBackup, createSampleAdmin, MB,
} from "../app/js/core/admin.js";

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

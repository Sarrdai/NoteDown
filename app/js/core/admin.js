// Logic of the admin dashboard (app/admin/) without DOM access: number and date
// formatting, usage levels, sorting, reading a backup file before restore, the
// storage-limit input, and the in-memory server of the sample mode (`?sample`).
// The API it mirrors is /v1/admin (the server owner's maintenance endpoints).

export const MB = 1024 * 1024;
export const MAX_QUOTA = 1024 * MB;      // MAX_QUOTA_OVERRIDE of the server: 1 GiB
export const BACKUP_FORMAT = "notedown-backup";
export const BACKUP_VERSION = 1;
export const BACKUP_TABLES = ["identities", "device_entries", "files", "file_members", "file_keys", "contacts", "invitations"];

const round1 = n => Math.round(n * 10) / 10;
const trim = n => String(round1(n));

/** "812 B", "73.2 KB", "1.7 MB", "2 GB". */
export function formatBytes(bytes) {
  if (!(bytes > 0)) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${trim(bytes / 1024)} KB`;
  if (bytes < 1024 * MB) return `${trim(bytes / MB)} MB`;
  return `${trim(bytes / 1024 / MB)} GB`;
}

/** The number of a size in MB without the unit: "2", "0.3", "< 0.1" (below 0.05 MB), "0". */
export function megabytes(bytes) {
  if (!(bytes > 0)) return "0";
  return bytes < 0.05 * MB ? "< 0.1" : trim(bytes / MB);
}

/** "0.3 of 2 MB" — the text under a storage bar. */
export const usageText = (used, quota) => `${megabytes(used)} of ${megabytes(quota)} MB`;

/** "9.4 MB of 512 MB" — the database meter: both sides with their unit. */
export const meterText = (used, limit) => `${formatBytes(used)} of ${formatBytes(limit)}`;

/** The first 8 characters of an ID. */
export const shortId = id => String(id).slice(0, 8);

/**
 * How full a storage is: `{ fraction (0..1), percent, level }` with the level "ok",
 * "warning" from 80 % and "full" from 100 % (the thresholds of the app's storage bar).
 */
export function usageLevel(used, quota) {
  const fraction = !(quota > 0) ? 1 : Math.max(0, Math.min(used / quota, 1));
  return { fraction, percent: Math.round(fraction * 100), level: fraction >= 1 ? "full" : fraction >= 0.8 ? "warning" : "ok" };
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * An ISO timestamp as "14 Oct 2026" (`time`: "14 Oct 2026, 09:12"), in the device's time
 * zone or in `timeZone`. "—" for none, the text itself when it is no date.
 */
export function formatDate(iso, { time = false, timeZone } = {}) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map(p => [p.type, p.value]));
  const day = `${+parts.day} ${MONTHS[+parts.month - 1]} ${parts.year}`;
  return time ? `${day}, ${parts.hour}:${parts.minute}` : day;
}

/** "2 devices · 3 files · last change 14 Oct 2026" — the phone card's meta line. */
export function cardMeta(identity, fmt = formatDate) {
  return `${plural(identity.devices, "device")} · ${plural(identity.files, "file")} · last change ${fmt(identity.updated)}`;
}

/** "Private" for a file only its owner is a member of, else "Shared · 3 people". */
export const fileScope = members => (members.length <= 1 ? "Private" : `Shared · ${members.length} people`);

// ---------- sorting ----------

export const SORT_KEYS = ["id", "created", "devices", "files", "used", "updated", "contacts"];

/** The direction a column starts with when picked: IDs ascending, everything else largest / newest first. */
export const defaultDirection = key => (key === "id" ? "asc" : "desc");

/**
 * The identities sorted by `key` (see SORT_KEYS) in `dir` ("asc" | "desc"); a missing value
 * (no file yet → `updated` null) always comes last, ties are ordered by ID. A new array.
 */
export function sortIdentities(list, key = "updated", dir = defaultDirection(key)) {
  const sign = dir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    const x = a[key], y = b[key];
    if ((x ?? null) === null || (y ?? null) === null) {
      if ((x ?? null) === (y ?? null)) return a.id < b.id ? -1 : 1;
      return x == null ? 1 : -1;
    }
    if (x !== y) return (x < y ? -1 : 1) * sign;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ---------- the storage limit input ----------

/**
 * Reads the storage-limit field (MB, a decimal point or comma): `{ quota }` in bytes (null =
 * empty = the default) or `{ error }`. The server accepts 1 byte .. 1 GiB.
 */
export function parseQuotaInput(text) {
  const t = String(text ?? "").trim().replace(",", ".");
  if (t === "") return { quota: null };
  if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return { error: "Enter a number of MB, for example 5 or 0.5." };
  const quota = Math.round(parseFloat(t) * MB);
  if (quota < 1) return { error: "The limit must be at least 1 byte." };
  if (quota > MAX_QUOTA) return { error: "The limit can be at most 1024 MB." };
  return { quota };
}

/** The bytes as the field's text: 10485760 → "10", 524288 → "0.5", null → "". */
export const quotaInputText = quota => (quota == null ? "" : String(Math.round(quota / MB * 1e6) / 1e6));

// ---------- backups ----------

/**
 * Reads a backup file's text before it is sent to the server: `{ backup, summary }` with
 * `summary = { created, identities, files }`, or `{ error }` with a sentence for the dialog.
 */
export function readBackup(text) {
  let backup;
  try { backup = JSON.parse(text); } catch { return { error: "This file is not valid JSON." }; }
  if (!backup || typeof backup !== "object" || Array.isArray(backup) || backup.format !== BACKUP_FORMAT) {
    return { error: "This is not a NoteDown backup." };
  }
  if (backup.version !== BACKUP_VERSION) return { error: `This backup has an unsupported version (${backup.version}).` };
  const tables = backup.tables;
  if (!tables || typeof tables !== "object" || Array.isArray(tables)) return { error: "The backup has no tables." };
  for (const name of BACKUP_TABLES) {
    if (!Array.isArray(tables[name])) return { error: `The backup is missing the table "${name}".` };
  }
  return {
    backup,
    summary: { created: typeof backup.created === "string" ? backup.created : null, identities: tables.identities.length, files: tables.files.length },
  };
}

/** "Backup from 14 Oct 2026, 09:12: 6 identities, 9 files" */
export function backupSummaryText({ created, identities, files }, fmt = d => formatDate(d, { time: true })) {
  return `Backup from ${created ? fmt(created) : "an unknown date"}: ${identities} ${identities === 1 ? "identity" : "identities"}, ${plural(files, "file")}`;
}

/** The sentence for a refused restore (`status`, `body` = the ApiError's). */
export function restoreErrorText(status, body) {
  const detail = body && body.detail ? String(body.detail) : "";
  if (status === 409) return "This backup would lock you out: it doesn't contain this identity or this device as an active device.";
  if (status === 413) return "The backup is too large for the server (32 MB).";
  if (status === 400) return "The server refused the backup" + (detail ? `: ${detail}` : ".");
  return null;   // anything else: the error's own message
}

/** The file name of a download: from a Content-Disposition header, else `notedown-backup-<date>.json`. */
export function backupFileName(contentDisposition, now = new Date()) {
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(contentDisposition || "");
  let name = m ? m[1].trim() : "";
  try { name = decodeURIComponent(name); } catch { /* keep as sent */ }
  name = name.replace(/[\\/]/g, "");
  return name || `notedown-backup-${now.toISOString().slice(0, 10)}.json`;
}

// ---------- sample mode ----------

/** A backup-shaped snapshot of the sample server (identities and files; `sample` lets the sample restore it). */
export function sampleBackup(data, now = new Date()) {
  const files = new Map();
  for (const d of Object.values(data.details)) for (const f of d.files) files.set(f.id, f);
  return {
    format: BACKUP_FORMAT, version: BACKUP_VERSION, created: now.toISOString(),
    tables: {
      identities: data.identities.map(i => ({ id: i.id, identity_key: "", created: i.created, quota: i.quota_override })),
      device_entries: [],
      files: [...files.values()].map(f => ({ id: f.id, owner: f.members[0], version: f.version, ciphertext: "", updated: f.updated, member_key: "" })),
      file_members: [...files.values()].flatMap(f => f.members.map(m => ({ file_id: f.id, identity_id: m }))),
      file_keys: [], contacts: [], invitations: [],
    },
    sample: data,
  };
}

/**
 * The admin API of the sample mode, kept in memory: the same methods as `createApi`'s
 * admin methods. `data` is app/sample/admin.json; errors carry a `status` like ApiError.
 */
export function createSampleAdmin(data) {
  let server = structuredClone(data);
  const fail = (status, detail) => Object.assign(new Error(`${status}: ${detail}`), { status, body: { detail } });
  const row = id => server.identities.find(i => i.id === id);
  return {
    adminOverview: async () => structuredClone(server.overview),
    adminIdentities: async () => ({ identities: structuredClone(server.identities) }),
    adminIdentity: async id => {
      const i = row(id);
      if (!i) throw fail(404, "not found");
      const { created, used, quota, quota_override } = i;
      return structuredClone({ ...server.details[id], created, used, quota, quota_override });
    },
    adminSetQuota: async (id, quota) => {
      const i = row(id);
      if (!i) throw fail(404, "not found");
      if (quota !== null && !(Number.isInteger(quota) && quota >= 1 && quota <= MAX_QUOTA)) throw fail(400, "invalid quota");
      i.quota_override = quota;
      i.quota = quota ?? server.overview.quota;
      return null;
    },
    adminBackup: async (now = new Date()) => ({
      text: JSON.stringify(sampleBackup(server, now), null, 1),
      filename: backupFileName("", now),
    }),
    adminRestore: async backup => {
      if (backup.sample && backup.sample.identities && backup.sample.details) server = structuredClone(backup.sample);
      return { identities: backup.tables.identities.length, files: backup.tables.files.length };
    },
  };
}

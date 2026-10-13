// Sync and sharing logic without DOM access (docs/sync-and-sharing.md): the
// names of circles of people, the tri-state of the share dialog, recovery
// keys, contact ids and the fake QR matrix the prototype draws.
// The prototype simulates the server and uses no real cryptography.

/** Key of a file's member set: sorted ids joined with "+" ("" = private). */
export function circleKey(memberIds) {
  return [...memberIds].sort().join("+");
}

/** "Lea" · "Lea & Tom" · "Lea, Tom & Grandma" ("" for nobody). */
export function circleLabel(names) {
  if (names.length <= 1) return names[0] || "";
  return names.slice(0, -1).join(", ") + " & " + names[names.length - 1];
}

/**
 * Tri-state of one contact over the selected notes: `memberSets` holds the
 * member ids of each selected note's file. "all" when every note is shared
 * with the contact, "none" when no note is, else "some".
 */
export function shareState(memberSets, contactId) {
  const n = memberSets.filter(m => m.includes(contactId)).length;
  return n === 0 ? "none" : n === memberSets.length ? "all" : "some";
}

/** First letters of the first two words, upper-case: "Uncle Bob" → "UB". */
export function initials(name) {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => [...w][0].toUpperCase()).join("");
}

/** Splits `file` into the private file and the circle files named by
 *  `groups` ([{ members, notes: [ids] }]); groups with the same member set
 *  share one file. Used to build the sample state (no moved markers). */
export function splitIntoCircles(file, groups) {
  const circles = new Map();
  let notes = file.notes;
  for (const g of groups) {
    const taken = notes.filter(n => g.notes.includes(n.id));
    notes = notes.filter(n => !g.notes.includes(n.id));
    const key = circleKey(g.members);
    if (!circles.has(key)) circles.set(key, { members: [...g.members], file: { preamble: "", notes: [], moved: [] } });
    circles.get(key).file.notes.push(...taken);
  }
  return { file: { ...file, notes, moved: file.moved || [] }, shared: [...circles.values()] };
}

// ---------- recovery key ----------

const KEY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789";

function randomInt(n) {
  const c = globalThis.crypto;
  if (c && c.getRandomValues) return c.getRandomValues(new Uint32Array(1))[0] % n;
  return Math.floor(Math.random() * n);
}

/** Random recovery key: 6 groups of 4 characters (A–Z, 2–9), "ABCD-…". */
export function generateRecoveryKey(random = randomInt) {
  const group = () => Array.from({ length: 4 }, () => KEY_ALPHABET[random(KEY_ALPHABET.length)]).join("");
  return Array.from({ length: 6 }, group).join("-");
}

/** Canonical form of a typed recovery key, or null when it is not one. */
export function normalizeRecoveryKey(input) {
  const raw = input.toUpperCase().replace(/[\s-]+/g, "");
  if (raw.length !== 24 || [...raw].some(c => !KEY_ALPHABET.includes(c))) return null;
  return raw.match(/.{4}/g).join("-");
}

/** A fake invitation link; the real one carries a key fingerprint and a token. */
export function inviteLink(random = randomInt) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  return "https://notedown.app/c#" + Array.from({ length: 16 }, () => chars[random(chars.length)]).join("");
}

// ---------- contacts and devices ----------

/** A local contact id from the name, unique among `taken`. */
export function contactId(name, taken = []) {
  const base = name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "contact";
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = base + "-" + i;
  return id;
}

/** "New device", "New device 2", … */
export function uniqueName(base, taken) {
  let name = base;
  for (let i = 2; taken.includes(name); i++) name = base + " " + i;
  return name;
}

/** Age of the last sync for the status line; both arguments in ms. */
export function syncedAgo(then, now = Date.now()) {
  const min = Math.floor((now - then) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return min === 1 ? "1 min ago" : `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return h === 1 ? "1 h ago" : `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 day ago" : `${d} days ago`;
}

// ---------- fake QR code ----------

export const QR_SIZE = 29;

/**
 * A QR-looking module grid (29×29, true = dark): three finder squares, the
 * timing lines, one alignment square and seeded pseudo-random modules. The
 * same seed always gives the same grid. Not a real, scannable code.
 */
export function qrMatrix(seed, size = QR_SIZE) {
  const next = prng(String(seed));
  const grid = Array.from({ length: size }, () => Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => Array(size).fill(false));
  const set = (x, y, dark) => { grid[y][x] = dark; fixed[y][x] = true; };

  for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let y = -1; y <= 7; y++) for (let x = -1; x <= 7; x++) {
      const gx = ox + x, gy = oy + y;
      if (gx < 0 || gy < 0 || gx >= size || gy >= size) continue;
      const inside = x >= 0 && x <= 6 && y >= 0 && y <= 6;
      const ring = x === 0 || x === 6 || y === 0 || y === 6;
      const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
      set(gx, gy, inside && (ring || core));
    }
  }
  for (let i = 8; i < size - 8; i++) { set(i, 6, i % 2 === 0); set(6, i, i % 2 === 0); }
  const a = size - 7;
  for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
    set(a + x, a + y, Math.max(Math.abs(x), Math.abs(y)) !== 1);
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (!fixed[y][x]) grid[y][x] = next() < 0.5;
  }
  return grid;
}

function prng(seed) {
  let h = 2166136261;
  for (const c of seed) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

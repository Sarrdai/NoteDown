// The vault's platforms (backlog #19; the format and the migration are core/vault.js):
// - Android app: the native Vault plugin (mobile/…/VaultPlugin.java) keeps the
//   records as files in the app's private storage and the data key sealed by the
//   Android Keystore; the app gets the key once per start and holds it as a
//   non-extractable CryptoKey.
// - Web: IndexedDB `notedown-vault`, the data key a non-extractable CryptoKey in
//   the same database.
// - Neither (no IndexedDB, unit tests): in memory only.
// The vault is opened once; on first use it takes over what an older version kept
// in plain text (localStorage, the file keys in IndexedDB `notedown`) and removes that.
import { sealRecord, openRecord, generateVaultKey, importVaultKey, migrateLegacy, legacyStorageKeys, secretName, isVaultable } from "./core/vault.js";

const DB = "notedown-vault";
const LEGACY_DB = "notedown";   // the key store of versions before the vault (sync/keystore.js keeps its CryptoKeys there)
const LEGACY_STORE = "keys";
const CHANNEL = "notedown-vault";

const b64 = bytes => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

// ---------- IndexedDB ----------

function idb(name, stores) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => stores.forEach(s => req.result.objectStoreNames.contains(s) || req.result.createObjectStore(s));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = t.onabort = () => reject(t.error);
  });
}

async function webBackend() {
  const db = await idb(DB, ["meta", "records"]);
  // Two tabs starting at once must agree on one key: the first stored one wins.
  const fresh = await generateVaultKey();
  const key = await new Promise((resolve, reject) => {
    const t = db.transaction("meta", "readwrite");
    let found = null;
    const req = t.objectStore("meta").get("key");
    req.onsuccess = () => { found = req.result || fresh; if (!req.result) t.objectStore("meta").put(fresh, "key"); };
    t.oncomplete = () => resolve(found);
    t.onerror = t.onabort = () => reject(t.error);
  });
  return {
    key,
    read: name => tx(db, "records", "readonly", s => s.get(name)),
    write: (name, bytes) => tx(db, "records", "readwrite", s => s.put(bytes, name)),
    remove: name => tx(db, "records", "readwrite", s => s.delete(name)),
    names: () => tx(db, "records", "readonly", s => s.getAllKeys()),
    clear: async () => { db.close(); await dropDatabase(DB); },
  };
}

function dropDatabase(name) {
  return new Promise(resolve => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

// ---------- Android ----------

async function nativeBackend() {
  const { registerPlugin } = await import("../vendor/capacitor-core.esm.js");
  const Vault = registerPlugin("Vault");
  const key = await importVaultKey(unb64((await Vault.dataKey()).key));
  return {
    key,
    read: async name => { const { data } = await Vault.read({ name }); return data == null ? undefined : unb64(data); },
    write: (name, bytes) => Vault.write({ name, data: b64(bytes) }),
    remove: name => Vault.remove({ name }),
    names: async () => (await Vault.list()).names,
    clear: () => Vault.clear(),
  };
}

// ---------- memory ----------

async function memoryBackend() {
  const records = new Map();
  return {
    key: await generateVaultKey(),
    read: async name => records.get(name),
    write: async (name, bytes) => { records.set(name, bytes); },
    remove: async name => { records.delete(name); },
    names: async () => [...records.keys()],
    clear: async () => records.clear(),
  };
}

const isNative = () => !!globalThis.Capacitor?.isNativePlatform?.();

// ---------- what older versions stored in plain text ----------

function legacyStorage() {
  let keys = [];
  try { keys = Object.keys(localStorage); } catch { /* no localStorage */ }
  return legacyStorageKeys(keys).map(({ key, name }) => {
    let raw = null;
    try { raw = localStorage.getItem(key); } catch { /* gone */ }
    return { key, name, value: raw };
  }).filter(i => i.value !== null);
}

async function legacySecrets() {
  if (typeof indexedDB === "undefined") return { items: [], db: null };
  // Only an existing database: opening creates it otherwise (sync/keystore.js creates it when it needs it).
  const known = indexedDB.databases ? (await indexedDB.databases()).some(d => d.name === LEGACY_DB) : true;
  if (!known) return { items: [], db: null };
  const db = await idb(LEGACY_DB, [LEGACY_STORE]);
  const keys = await tx(db, LEGACY_STORE, "readonly", s => s.getAllKeys());
  const items = [];
  for (const k of keys) {
    const value = await tx(db, LEGACY_STORE, "readonly", s => s.get(k));
    if (typeof k === "string" && isVaultable(value)) items.push({ key: k, name: secretName(k), value });
  }
  return { items, db };
}

async function takeOverLegacy(vault) {
  const storage = legacyStorage();
  const secrets = await legacySecrets();
  try {
    return await migrateLegacy({
      items: async () => [...storage, ...secrets.items].map(({ name, value }) => ({ name, value })),
      remove: async names => {
        for (const i of storage) if (names.includes(i.name)) try { localStorage.removeItem(i.key); } catch { /* gone */ }
        if (secrets.db) for (const i of secrets.items) if (names.includes(i.name)) await tx(secrets.db, LEGACY_STORE, "readwrite", s => s.delete(i.key));
      },
    }, vault);
  } finally {
    secrets.db?.close();
  }
}

// ---------- the vault ----------

let opening = null;
const changeListeners = new Set();

/** Calls `fn(name)` when another tab of this browser wrote a record (the import page, a second app tab). */
export function onVaultChange(fn) { changeListeners.add(fn); }

/**
 * Opens the vault (once per page): { get(name), put(name, value), remove(name), clear() }. Values are JSON-able,
 * Uint8Array allowed; `put` resolves once the record is stored. Takes over plain data of older versions first.
 */
export function openVault() {
  opening ||= (async () => {
    let backend;
    if (isNative()) backend = await nativeBackend();
    else if (typeof indexedDB !== "undefined") backend = await webBackend().catch(() => memoryBackend());
    else backend = await memoryBackend();
    const vault = makeVault(backend);
    await takeOverLegacy(vault);
    return vault;
  })();
  return opening;
}

function makeVault(backend) {
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL) : null;
  if (channel) channel.onmessage = e => changeListeners.forEach(fn => fn(e.data.name));
  channel?.unref?.();   // Node (unit tests): an open channel would keep the process alive
  // Writes of one record go out in order, and only the newest of several waiting ones is written.
  const queue = new Map();   // name → { done: Promise, next: { value } | null }
  let cleared = false;
  async function store(name, value) {
    if (cleared) return;
    if (value === undefined) await backend.remove(name);
    else await backend.write(name, await sealRecord(backend.key, name, value));
    channel?.postMessage({ name });
  }
  function put(name, value) {
    const q = queue.get(name);
    if (q) { q.next = { value }; return q.done; }
    const entry = { next: null };
    entry.done = (async () => {
      let v = value;
      for (;;) {
        await store(name, v);
        if (!entry.next) break;
        v = entry.next.value;
        entry.next = null;
      }
      queue.delete(name);
    })();
    queue.set(name, entry);
    return entry.done;
  }
  return {
    async get(name) {
      const bytes = await backend.read(name);
      return bytes === undefined || bytes === null ? undefined : openRecord(backend.key, name, bytes);
    },
    put,
    remove: name => put(name, undefined),
    /** Removes every record whose name starts with `prefix`. */
    async removePrefix(prefix) {
      const names = new Set([...await backend.names(), ...queue.keys()]);
      await Promise.all([...names].filter(n => n.startsWith(prefix)).map(n => put(n, undefined)));
    },
    /** Waits for every write still on its way. */
    flush: () => Promise.all([...queue.values()].map(q => q.done)),
    /** Erases every record and the data key (signing out); no write gets through afterwards. */
    async clear() {
      cleared = true;
      await Promise.all([...queue.values()].map(q => q.done.catch(() => {})));
      await backend.clear();
      opening = null;
    },
  };
}

/** One record's value, or undefined (the pages beside the app: their theme, the admin page's sync state). */
export async function readStored(name) {
  try { return await (await openVault()).get(name); } catch { return undefined; }
}

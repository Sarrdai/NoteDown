// This device's secrets in IndexedDB: the device keys (non-extractable
// CryptoKeys, which only IndexedDB can hold) and the file keys
// (docs/sync-and-sharing.md → "Identity and devices").
const DB = "notedown";
const STORE = "keys";

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** The stored value for `key`, or undefined. */
export const getSecret = key => run("readonly", s => s.get(key));

export const setSecret = (key, value) => run("readwrite", s => s.put(value, key));

export const clearSecrets = () => run("readwrite", s => s.clear());

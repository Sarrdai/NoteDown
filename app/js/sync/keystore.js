// This device's secrets (docs/sync-and-sharing.md → "Identity and devices"):
// the file keys and every other secret that is plain data live in the
// encrypted vault (app/js/vault.js, backlog #19) as `secret:<key>`; the device
// keys of devices linked before the vault are non-extractable CryptoKeys, which
// only IndexedDB can hold and the vault can't encrypt, so they stay in IndexedDB
// `notedown`.
import { openVault } from "../vault.js";
import { secretName, isVaultable } from "../core/vault.js";

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
export async function getSecret(key) {
  const value = await (await openVault()).get(secretName(key));
  return value !== undefined ? value : run("readonly", s => s.get(key));
}

/** Stores a secret: plain data encrypted in the vault, CryptoKey objects in IndexedDB. */
export async function setSecret(key, value) {
  const vault = await openVault();
  if (isVaultable(value)) {
    await vault.put(secretName(key), value);
    await run("readwrite", s => s.delete(key));
  } else {
    await run("readwrite", s => s.put(value, key));
    await vault.remove(secretName(key));
  }
}

export async function deleteSecret(key) {
  await (await openVault()).remove(secretName(key));
  await run("readwrite", s => s.delete(key));
}

/** Removes every secret (device and file keys), keeping the vault's other records (the notes). */
export async function clearSecrets() {
  const vault = await openVault();
  await vault.removePrefix(secretName(""));
  await run("readwrite", s => s.clear());
}

/** Deletes the IndexedDB key store, device keys included (signing out; the vault is erased by the store). */
export function deleteDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();   // deleted as soon as the other connection closes
  });
}

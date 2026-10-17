// This device's secrets (docs/sync-and-sharing.md → "Where the files live"): the
// seeds of the device keys, the file keys and every other secret, as `secret:<key>`
// in the encrypted vault (app/js/vault.js; on Android its data key is sealed by the
// Keystore). Secrets are plain data; the device keys are imported from their seeds
// as non-extractable CryptoKeys in memory only (core/crypto.js → deviceKeysFromSeeds).
import { openVault } from "../vault.js";
import { secretName } from "../core/vault.js";

/** The stored value for `key`, or undefined. */
export async function getSecret(key) {
  return (await openVault()).get(secretName(key));
}

/** Stores a secret (plain data: JSON-able values and byte arrays). */
export async function setSecret(key, value) {
  await (await openVault()).put(secretName(key), value);
}

export async function deleteSecret(key) {
  await (await openVault()).remove(secretName(key));
}

/** Removes every secret (device and file keys), keeping the vault's other records (the notes). */
export async function clearSecrets() {
  await (await openVault()).removePrefix(secretName(""));
}

/**
 * Deletes IndexedDB `notedown`, where app versions before backlog #61 kept the device keys, so erasing
 * this device leaves none behind (the vault is erased by the store).
 */
export function deleteOldKeyStore() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase("notedown");
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();   // deleted as soon as the other connection closes
  });
}

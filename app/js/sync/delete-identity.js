// Deleting an identity with its recovery key (docs/server-api.md → "Blocked and deleted identities"):
// the recovery key gives the identity key, which signs a fresh challenge. Used by Sync & sharing and by
// the delete page (app/delete/), which has no device of its own.
import * as c from "../core/crypto.js";

/** Deletes the identity of `recoveryKey` on the server of `api` (sync/api.js); `expected`, when given, is the
 *  identity ID it must belong to. → the identity ID. Throws an Error with a sentence for the user. */
export async function deleteWithRecoveryKey(api, recoveryKey, expected = null) {
  const bytes = c.recoveryKeyBytes(recoveryKey);
  if (!bytes) throw new Error("That doesn't look like a recovery key. It has 26 letters and digits.");
  const { identity: key } = await c.deriveRecovery(bytes);
  const identity = await c.keyId(key.publicKey);
  if (expected && identity !== expected) throw new Error("That's not the recovery key of these notes.");
  const { challenge } = await api.challenge();
  try {
    await api.deleteIdentity(identity, challenge, await c.signDeletion(key.privateKey, challenge));
  } catch (e) {
    if (e.status === 404) throw new Error("No notes are synced with this recovery key on this server.");
    throw e;
  }
  return identity;
}

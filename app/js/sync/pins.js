// Device lists only grow (docs/sync-and-sharing.md → "Identity and devices", security review H3): this device
// remembers how far it has seen each identity's list and refuses one that goes back or has another past, as a
// server could otherwise hand out an older list in which a removed device is still active. The pins are a secret
// of the vault (keystore.js), so they go with the identity's other secrets.
import * as c from "../core/crypto.js";
import { getSecret, setSecret } from "./keystore.js";

let pins = null;   // identity ID → { n, head } (crypto.chainPin), read from the vault on first use

/** Forgets the pins held in memory (the vault's secrets were cleared). */
export function forgetPins() {
  pins = null;
}

/** Pins `entries` as `identity`'s list when they are longer than the one pinned (after this device appended to it). */
export async function pinChain(identity, entries) {
  pins ||= (await getSecret("pins")) || {};
  const next = await c.chainPin(entries);
  if (pins[identity] && pins[identity].n >= next.n) return;
  pins = { ...pins, [identity]: next };
  await setSecret("pins", pins);
}

/** The verified devices of `identity`'s list `entries` (crypto.verifyChain) once they go on from what this device saw of it; pins them. */
export async function pinnedChain(identity, identityKey, entries) {
  const devices = await c.verifyChain(identityKey, entries);
  pins ||= (await getSecret("pins")) || {};
  await c.checkPin(pins[identity], entries);
  await pinChain(identity, entries);
  return devices;
}

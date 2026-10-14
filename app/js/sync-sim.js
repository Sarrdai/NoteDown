// Prototype only: simulates the server side of sync for the sample
// (`state.sync.simulated`, docs/sync-and-sharing.md → "Sync"). Every file
// change while sync is on shows "syncing" for a moment, then "synced";
// while offline it stays "offline" and catches up when the device is back
// online. Views follow the "sync" events the store emits.
import { state, setSync, onFilesChanged } from "./store.js";

const BUSY_MS = 900;
let timer = null;
let waiting = [];   // resolvers of the round on its way

export function initSyncSim() {
  onFilesChanged(syncNow);
}

/** Starts a (simulated) sync round now; resolves when it is over. */
export function syncNow() {
  clearTimeout(timer);
  if (!state.sync.enabled || !state.sync.simulated) return Promise.resolve(finish());
  if (state.sync.offline) { setSync({ status: "offline" }); return Promise.resolve(finish()); }
  setSync({ status: "syncing" });
  timer = setTimeout(() => { setSync({ status: "synced", lastSync: Date.now() }); finish(); }, BUSY_MS);
  return new Promise(resolve => waiting.push(resolve));
}

function finish() {
  waiting.splice(0).forEach(resolve => resolve());
}

/** ⋮ → "Go offline" / "Go online". */
export function setOffline(offline) {
  clearTimeout(timer);
  setSync({ offline });
  if (state.sync.enabled) syncNow();
}

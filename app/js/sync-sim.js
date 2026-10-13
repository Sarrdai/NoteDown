// Prototype only: simulates the server side of sync (docs/sync-and-sharing.md
// → "Sync"). Every file change while sync is on shows "syncing" for a moment,
// then "synced"; while offline it stays "offline" and catches up when the
// device is back online. Views follow the "sync" events the store emits.
import { state, setSync, onFilesChanged } from "./store.js";

const BUSY_MS = 900;
let timer = null;

export function initSyncSim() {
  onFilesChanged(syncNow);
}

/** Starts a (simulated) sync round now. */
export function syncNow() {
  clearTimeout(timer);
  if (!state.sync.enabled) return;
  if (state.sync.offline) { setSync({ status: "offline" }); return; }
  setSync({ status: "syncing" });
  timer = setTimeout(() => setSync({ status: "synced", lastSync: Date.now() }), BUSY_MS);
}

/** ⋮ → "Go offline" / "Go online". */
export function setOffline(offline) {
  clearTimeout(timer);
  setSync({ offline });
  if (state.sync.enabled) syncNow();
}

// The screen lock's layer and its triggers (backlog #6; the decisions are core/app-lock.js): a full-screen,
// opaque layer above everything that NoteDown shows while it is locked, opened at start and when the app comes
// back after being away for the chosen time, and closed by the system's PIN, pattern, password or fingerprint
// (the native Privacy plugin, or its stand-in in the simulation, platform.js). The layer is no history entry:
// the Android back key doesn't close it.
import { state, updateSettings } from "../store.js";
import { lockDue } from "../core/app-lock.js";
import { isAndroidApp, isNativeApp, nativeApp, privacyPlugin } from "../platform.js";
import { showSnackbar } from "./snackbar.js";

const $ = id => document.getElementById(id);
const EXPECTED_MS = 10000;   // a share sheet or file picker NoteDown opened hides the app right after
let hiddenAt = null;         // when the app went away, null while it is in front
let skipReturn = false;      // that absence was one NoteDown asked for
let expectedAt = 0;
let prompting = false;

/** The next absence doesn't lock: NoteDown is about to open a share sheet or a file picker itself. */
export function expectReturn() {
  expectedAt = Date.now();
}

const locked = () => !$("appLock").hidden;

/** Shows the layer; with `ask` the system's unlock prompt opens at once. */
export function showLockScreen({ ask = true } = {}) {
  $("appLock").hidden = false;
  $("appLockUnlock").focus({ preventScroll: true });
  if (ask) unlock();
}

async function unlock() {
  if (prompting) return;
  prompting = true;
  try {
    await privacyPlugin().unlock({ title: "Unlock NoteDown", subtitle: "" });
    $("appLock").hidden = true;
    hiddenAt = null;
  } catch (e) {
    if (e?.code === "unavailable") {
      // The phone's screen lock was removed meanwhile: nothing left to unlock with.
      $("appLock").hidden = true;
      updateSettings({ lock: { ...state.settings.lock, on: false } });
      showSnackbar("Screen lock is off: no screen lock is set up on this phone");
    }
    // Canceled: the layer stays with its Unlock button.
  } finally {
    prompting = false;
  }
}

function away() {
  if (prompting || hiddenAt != null) return;
  hiddenAt = Date.now();
  skipReturn = Date.now() - expectedAt < EXPECTED_MS;
  expectedAt = 0;
}

function back() {
  if (prompting) return;
  const at = hiddenAt;
  const skip = skipReturn;
  hiddenAt = null;
  skipReturn = false;
  if (locked()) unlock();
  else if (lockDue(state.settings.lock, at, Date.now(), skip)) showLockScreen();
}

/** Call after the stored state is loaded and before the first render. */
export function initAppLock() {
  if (!isAndroidApp()) return;
  $("appLockUnlock").addEventListener("click", unlock);
  if (isNativeApp() && nativeApp) nativeApp.addListener("appStateChange", ({ isActive }) => (isActive ? back() : away()));
  else document.addEventListener("visibilitychange", () => (document.hidden ? away() : back()));
  if (state.settings.lock.on) showLockScreen();
}

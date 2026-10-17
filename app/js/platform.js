// Which platform NoteDown runs on, and the native plugins only the Android app has (Privacy, ShareFile, App).
// `?platform=android` (prototype only) simulates the Android app in a browser, so its settings and the lock
// screen can be seen and screenshotted: every native call is then replaced by a stand-in kept in this file,
// so the views never branch on the simulation themselves.
import { Capacitor, registerPlugin } from "../vendor/capacitor-core.esm.js";

const native = Capacitor.isNativePlatform();
const simulated = !native && new URLSearchParams(location.search).get("platform") === "android";

/** The Android app, or its simulation in a browser. */
export const isAndroidApp = () => native || simulated;

/** Only the real Android app (not the simulation). */
export const isNativeApp = () => native;

/** `@capacitor/app` (null outside the Android app): app state changes, invitation links. */
export const nativeApp = native ? registerPlugin("App") : null;

const nativePrivacy = native ? registerPlugin("Privacy") : null;
const nativeShare = native ? registerPlugin("ShareFile") : null;

// Stand-in for the Privacy plugin in the simulation: the phone has a screen lock, unlocking takes a moment.
const fakePrivacy = {
  get: async () => ({ screenSecurity: true, incognitoKeyboard: true, canLock: true }),
  set: async () => {},
  unlock: () => new Promise(resolve => setTimeout(resolve, 600)),
};

/** The Privacy plugin (screen security, incognito keyboard, system unlock), or its stand-in; null off Android. */
export const privacyPlugin = () => nativePrivacy || (simulated ? fakePrivacy : null);

/** The ShareFile plugin (hands a file to the share sheet); null on the web and in the simulation (a download). */
export const shareFilePlugin = () => nativeShare;

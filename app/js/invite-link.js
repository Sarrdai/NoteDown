// Opening an invitation link in the app (docs/server-api.md → "Contacts and
// invitations"): on the web, app/invite/index.html forwards a visited link to
// the app with the fragment kept; in the Android app the App Link opens the
// app itself (`appUrlOpen`, or the launch URL on a cold start). Both hand the
// link's text to `open`. Also the web address that invitation links start with.
import { nativeApp } from "./platform.js";
import { parseInvitationLink } from "./core/linking.js";

const NativeApp = nativeApp;
const SAME_LINK_MS = 2000;   // the launch URL and the retained `appUrlOpen` event both report a cold start

/** The web address of this app (no trailing slash): the configured one (`web` in app/config.json, the
 *  Android app has no web address of its own), else where this page was loaded from; "" if unknown. */
export function webAddress(configured = "") {
  if (configured) return configured.replace(/\/+$/, "");
  return NativeApp ? "" : new URL("./", location.href).href.replace(/\/+$/, "");
}

/** Calls `open(link text)` for an invitation link the app was opened with, now or later. */
export function initInviteLinks(open) {
  // Forwarded from <web>/invite/: the fragment is all that is left of the link.
  if (location.hash.startsWith("#v=1&")) {
    const text = new URL("invite/", location.href).href + location.hash;
    history.replaceState(history.state, "", location.pathname + location.search);
    if (parseInvitationLink(text)) open(text);
  }
  if (!NativeApp) return;
  let last = "", at = 0;
  const opened = url => {
    if (!url || !parseInvitationLink(url) || (url === last && Date.now() - at < SAME_LINK_MS)) return;
    last = url;
    at = Date.now();
    open(url);
  };
  NativeApp.addListener("appUrlOpen", ({ url }) => opened(url));
  NativeApp.getLaunchUrl().then(launch => opened(launch && launch.url)).catch(() => {});
}

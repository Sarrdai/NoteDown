// Quick capture from outside the app (docs/requirements.md → "Quick capture"): the Android app shortcuts
// "New note" and "Dictate" (long-press on the app icon) and the Quick Settings tile "New note" open the app
// with an action. The QuickCapture plugin hands it over — retained on a cold start, as an event while the app
// runs. In a browser `?shortcut=new` or `?shortcut=dictate` (prototype only) stands in for them. The action
// waits until NoteDown is in front and unlocked (screen lock).
import { quickCapturePlugin } from "./platform.js";
import { whenUnlocked } from "./ui/app-lock.js";

/** Calls `actions.new()`, `actions.dictate()` or `actions.share({ text, subject })` for the quick-capture action
 *  the app was opened with, now or later. */
export function initQuickCapture(actions) {
  const run = ({ action, text = "", subject = "" }) => {
    if (action === "new" || action === "dictate") whenUnlocked(actions[action]);
    else if (action === "share") whenUnlocked(() => actions.share({ text, subject }));
  };
  const url = new URL(location.href);
  const action = url.searchParams.get("shortcut");
  if (action !== null) {
    const shared = { action, text: url.searchParams.get("text") ?? "", subject: url.searchParams.get("subject") ?? "" };
    // Once only: a reload doesn't create another note.
    for (const key of ["shortcut", "text", "subject"]) url.searchParams.delete(key);
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    run(shared);
  }
  if (quickCapturePlugin) quickCapturePlugin.addListener("action", run);
}

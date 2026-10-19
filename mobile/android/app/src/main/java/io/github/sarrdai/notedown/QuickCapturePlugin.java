package io.github.sarrdai.notedown;

import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Quick capture from outside the app (docs/requirements.md → "Quick capture"): the app shortcuts "New note" and
 * "Dictate" (res/xml/shortcuts.xml, through QuickCaptureActivity) and the Quick Settings tile (QuickNoteTileService)
 * start MainActivity with one of the actions below. The plugin hands it to the web code (app/js/quick-capture.js)
 * as the event "action" with { action: "new" | "dictate" }, retained on a cold start until the listener is there.
 */
@CapacitorPlugin(name = "QuickCapture")
public class QuickCapturePlugin extends Plugin {

    static final String ACTION_NEW_NOTE = "io.github.sarrdai.notedown.NEW_NOTE";
    static final String ACTION_DICTATE = "io.github.sarrdai.notedown.DICTATE";

    @Override
    public void load() {
        handle(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        handle(intent);
    }

    private void handle(Intent intent) {
        if (intent == null) return;
        // Reopened from the recent apps, the activity gets its first intent again: that action was done then.
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;
        String action = ACTION_NEW_NOTE.equals(intent.getAction()) ? "new"
            : ACTION_DICTATE.equals(intent.getAction()) ? "dictate" : null;
        if (action == null) return;
        JSObject data = new JSObject();
        data.put("action", action);
        notifyListeners("action", data, true);
    }
}

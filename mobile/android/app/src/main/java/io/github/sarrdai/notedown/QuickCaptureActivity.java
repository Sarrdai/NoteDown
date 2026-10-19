package io.github.sarrdai.notedown;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/**
 * The target of the app shortcuts (res/xml/shortcuts.xml): passes their action on to MainActivity and closes.
 * The launcher starts a static shortcut with FLAG_ACTIVITY_CLEAR_TASK, which would restart a running NoteDown;
 * this activity has a task of its own, so only it is cleared and the running app just gets the action.
 */
public class QuickCaptureActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        startActivity(new Intent(this, MainActivity.class)
            .setAction(getIntent().getAction())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        finish();
    }
}

package io.github.sarrdai.notedown;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DictationPlugin.class);
        registerPlugin(ShareFilePlugin.class);
        registerPlugin(VaultPlugin.class);
        registerPlugin(PrivacyPlugin.class);
        registerPlugin(FolderSourcePlugin.class);
        registerPlugin(QuickCapturePlugin.class);
        // Recreated after the system ended the process, the activity gets its launch intent again (a shared
        // text, a shortcut, a notification tap): that was handled then, so it doesn't reach the plugins twice.
        if (savedInstanceState != null) setIntent(new Intent(this, MainActivity.class));
        super.onCreate(savedInstanceState);
        // Screen security from the first frame (backlog #59), before the web code has loaded.
        PrivacyPlugin.applyScreenSecurity(this);
    }
}

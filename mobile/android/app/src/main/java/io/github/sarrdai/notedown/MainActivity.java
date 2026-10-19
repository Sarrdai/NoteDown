package io.github.sarrdai.notedown;

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
        super.onCreate(savedInstanceState);
        // Screen security from the first frame (backlog #59), before the web code has loaded.
        PrivacyPlugin.applyScreenSecurity(this);
    }
}

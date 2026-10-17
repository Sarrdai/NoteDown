package io.github.sarrdai.notedown;

import android.content.Context;
import android.os.Build;
import android.util.AttributeSet;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import com.getcapacitor.CapacitorWebView;

/**
 * Capacitor's web view with the incognito keyboard (backlog #59): while it is on (PrivacyPlugin), every text
 * field asks the keyboard not to learn from what is typed (IME_FLAG_NO_PERSONALIZED_LEARNING, as Signal's
 * "Incognito keyboard"). Used through res/layout/capacitor_bridge_layout_main.xml, which replaces Capacitor's.
 */
public class SecureWebView extends CapacitorWebView {

    public SecureWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    @Override
    public InputConnection onCreateInputConnection(EditorInfo outAttrs) {
        InputConnection connection = super.onCreateInputConnection(outAttrs);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && PrivacyPlugin.incognitoKeyboard(getContext())) {
            outAttrs.imeOptions |= EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING;
        }
        return connection;
    }
}

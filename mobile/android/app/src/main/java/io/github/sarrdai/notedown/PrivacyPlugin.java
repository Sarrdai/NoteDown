package io.github.sarrdai.notedown;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The device-side protections of the privacy settings (docs/requirements.md → "Privacy on the device"):
 * - Screen security (backlog #59): FLAG_SECURE keeps NoteDown out of the recent-apps preview and screenshots.
 * - Incognito keyboard (backlog #59): SecureWebView asks the keyboard not to learn from what is typed.
 * - Screen lock (backlog #6): BiometricPrompt with the system's PIN, pattern, password or biometrics.
 * Both switches are on by default and kept here as plain booleans (no note data), so they hold from the
 * first frame of the next start, before the web code has loaded.
 *
 * get() → { screenSecurity, incognitoKeyboard, canLock }; set({ screenSecurity?, incognitoKeyboard? });
 * unlock({ title, subtitle }) resolves once the user unlocked, rejects with "canceled" or "unavailable".
 */
@CapacitorPlugin(name = "Privacy")
public class PrivacyPlugin extends Plugin {

    private static final String PREFS = "notedown-privacy";

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean screenSecurity(Context context) {
        return prefs(context).getBoolean("screenSecurity", true);
    }

    static boolean incognitoKeyboard(Context context) {
        return prefs(context).getBoolean("incognitoKeyboard", true);
    }

    /** Sets or clears FLAG_SECURE on the activity's window by the stored setting. */
    static void applyScreenSecurity(Activity activity) {
        if (screenSecurity(activity)) activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        else activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
    }

    // The system screen lock, biometrics where enrolled: strong biometrics or the device credential from
    // Android 11 on; before that the combination androidx.biometric supports (weak biometrics or credential).
    private static int authenticators() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
            ? BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL
            : BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
    }

    private boolean canLock() {
        return BiometricManager.from(getContext()).canAuthenticate(authenticators()) == BiometricManager.BIOMETRIC_SUCCESS;
    }

    @PluginMethod
    public void get(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("screenSecurity", screenSecurity(getContext()));
        ret.put("incognitoKeyboard", incognitoKeyboard(getContext()));
        ret.put("canLock", canLock());
        call.resolve(ret);
    }

    @PluginMethod
    public void set(PluginCall call) {
        SharedPreferences.Editor edit = prefs(getContext()).edit();
        if (call.getData().has("screenSecurity")) edit.putBoolean("screenSecurity", call.getBoolean("screenSecurity", true));
        if (call.getData().has("incognitoKeyboard")) edit.putBoolean("incognitoKeyboard", call.getBoolean("incognitoKeyboard", true));
        edit.apply();
        getActivity().runOnUiThread(() -> {
            applyScreenSecurity(getActivity());
            // A field that has the keyboard open picks up the new flag.
            InputMethodManager imm = (InputMethodManager) getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm != null && getBridge().getWebView() != null) imm.restartInput(getBridge().getWebView());
            call.resolve();
        });
    }

    @PluginMethod
    public void unlock(PluginCall call) {
        if (!canLock()) {
            call.reject("No screen lock is set up on this device", "unavailable");
            return;
        }
        FragmentActivity activity = getActivity();
        activity.runOnUiThread(() -> {
            BiometricPrompt prompt = new BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    call.resolve();
                }

                @Override
                public void onAuthenticationError(int code, CharSequence message) {
                    call.reject(message.toString(), "canceled");
                }
            });
            BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle(call.getString("title", "Unlock NoteDown"))
                .setSubtitle(call.getString("subtitle", null))
                .setAllowedAuthenticators(authenticators())
                .build();
            prompt.authenticate(info);
        });
    }
}

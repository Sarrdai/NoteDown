package io.github.sarrdai.notedown;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;

/**
 * Speech input through Android's SpeechRecognizer, for app/js/ui/dictation.js
 * (the web view has no working Web Speech API). One start() is one
 * recognition session; it emits "partial" {text}, "final" {text},
 * "level" {value 0..1}, "error" {code} with Web Speech error codes, and
 * "end" when the session is over. Continuous listening restarts from JS.
 * start({onDevice: true}) uses the on-device recognizer only (Android 12+),
 * never the online one: without it, it rejects with "on-device-unavailable".
 */
@CapacitorPlugin(
    name = "Dictation",
    permissions = { @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "microphone") }
)
public class DictationPlugin extends Plugin {

    private SpeechRecognizer recognizer;
    private boolean recognizerOnDevice; // which kind `recognizer` is
    private SpeechRecognizer downloader; // kept until destroy, so the download request reaches the service
    private boolean session; // between startListening and its one "end"
    private volatile boolean cancelled; // stop() or cancel() came while the permission dialog was open

    @PluginMethod
    public void available(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", SpeechRecognizer.isRecognitionAvailable(getContext()));
        call.resolve(ret);
    }

    @PluginMethod
    public void start(PluginCall call) {
        cancelled = false;
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "permissionAnswered");
            return;
        }
        listen(call);
    }

    @PermissionCallback
    private void permissionAnswered(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) call.reject("Microphone access was denied", "not-allowed");
        else if (cancelled) call.resolve();
        else listen(call);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        cancelled = true;
        getActivity().runOnUiThread(() -> {
            if (recognizer != null) recognizer.stopListening();
            call.resolve();
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        cancelled = true;
        getActivity().runOnUiThread(() -> {
            session = false;
            if (recognizer != null) recognizer.cancel();
            call.resolve();
        });
    }

    /** Asks the on-device recognizer to download the language's speech pack (Android 13+). */
    @PluginMethod
    public void downloadLanguage(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || !SpeechRecognizer.isOnDeviceRecognitionAvailable(getContext())) {
            call.reject("Speech pack download needs Android 13", "unsupported");
            return;
        }
        Intent intent = recognizerIntent(call.getString("lang"));
        getActivity().runOnUiThread(() -> {
            if (downloader == null) downloader = SpeechRecognizer.createOnDeviceSpeechRecognizer(getContext());
            downloader.triggerModelDownload(intent);
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (recognizer != null) recognizer.destroy();
        if (downloader != null) downloader.destroy();
    }

    private static Intent recognizerIntent(String lang) {
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        if (lang != null) intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        return intent;
    }

    private void listen(PluginCall call) {
        Intent intent = recognizerIntent(call.getString("lang"));
        boolean onDevice = Boolean.TRUE.equals(call.getBoolean("onDevice", true));

        getActivity().runOnUiThread(() -> {
            if (onDevice) {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || !SpeechRecognizer.isOnDeviceRecognitionAvailable(getContext())) {
                    call.reject("No on-device speech recognition on this device", "on-device-unavailable");
                    return;
                }
            } else if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
                call.reject("No speech recognition on this device", "service-not-allowed");
                return;
            }
            if (recognizer != null && recognizerOnDevice != onDevice) {
                recognizer.destroy();
                recognizer = null;
            }
            if (recognizer == null) {
                recognizer = onDevice && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                    ? SpeechRecognizer.createOnDeviceSpeechRecognizer(getContext())
                    : SpeechRecognizer.createSpeechRecognizer(getContext());
                recognizerOnDevice = onDevice;
                recognizer.setRecognitionListener(new Listener());
            }
            session = true;
            recognizer.startListening(intent);
            call.resolve();
        });
    }

    private void emitText(String event, Bundle results) {
        ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        JSObject ret = new JSObject();
        ret.put("text", matches == null || matches.isEmpty() ? "" : matches.get(0));
        notifyListeners(event, ret);
    }

    private class Listener implements RecognitionListener {

        @Override
        public void onPartialResults(Bundle results) {
            emitText("partial", results);
        }

        @Override
        public void onResults(Bundle results) {
            if (!session) return;
            session = false;
            emitText("final", results);
            notifyListeners("end", new JSObject());
        }

        @Override
        public void onError(int error) {
            // Some recognizers report an error after the results; the session is over then.
            if (!session) return;
            session = false;
            JSObject ret = new JSObject();
            ret.put("code", errorCode(error));
            notifyListeners("error", ret);
            notifyListeners("end", new JSObject());
        }

        @Override
        public void onRmsChanged(float rmsdB) {
            // Roughly -2 dB (silence) to 10 dB (loud speech).
            JSObject ret = new JSObject();
            ret.put("value", Math.max(0, Math.min(1, (rmsdB + 2) / 12)));
            notifyListeners("level", ret);
        }

        @Override
        public void onReadyForSpeech(Bundle params) {}

        @Override
        public void onBeginningOfSpeech() {}

        @Override
        public void onBufferReceived(byte[] buffer) {}

        @Override
        public void onEndOfSpeech() {}

        @Override
        public void onEvent(int eventType, Bundle params) {}
    }

    private static String errorCode(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_NO_MATCH:
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "no-speech";
            case SpeechRecognizer.ERROR_CLIENT:
                return "aborted";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "not-allowed";
            case SpeechRecognizer.ERROR_AUDIO:
                return "audio-capture";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
            case SpeechRecognizer.ERROR_SERVER:
                return "network";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "busy";
            case SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED:
                return "language-not-supported";
            case SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE: // supported, but its speech pack isn't on the phone
                return "language-unavailable";
            default:
                return "error-" + error;
        }
    }
}

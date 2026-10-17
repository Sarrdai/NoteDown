package io.github.sarrdai.notedown;

import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;

/**
 * Hands a file to the system's share sheet (save to Files or Drive, send),
 * for the export in app/js/ui/export.js: the web view ignores downloads.
 * share({ name, data: base64, type }) writes it to the cache and opens the
 * chooser; it resolves once the sheet is shown.
 */
@CapacitorPlugin(name = "ShareFile")
public class ShareFilePlugin extends Plugin {

    @PluginMethod
    public void share(PluginCall call) {
        String name = call.getString("name");
        String data = call.getString("data");
        String type = call.getString("type", "application/octet-stream");
        if (name == null || data == null || name.contains("/")) {
            call.reject("name and data are required");
            return;
        }
        try {
            File dir = new File(getContext().getCacheDir(), "export");
            if (!dir.isDirectory() && !dir.mkdirs()) throw new Exception("No cache directory");
            File file = new File(dir, name);
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(Base64.decode(data, Base64.DEFAULT));
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
            Intent send = new Intent(Intent.ACTION_SEND)
                .setType(type)
                .putExtra(Intent.EXTRA_STREAM, uri)
                .putExtra(Intent.EXTRA_TITLE, name)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            send.setClipData(ClipData.newRawUri(name, uri));
            Intent chooser = Intent.createChooser(send, name).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(chooser);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not share the file", e);
        }
    }
}

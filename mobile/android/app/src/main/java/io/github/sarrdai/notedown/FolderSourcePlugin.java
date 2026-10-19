package io.github.sarrdai.notedown;

import android.content.ContentResolver;
import android.content.Intent;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * Folder sources (app/js/ui/folder-sources.js, docs/requirements.md → "Folder sources"): a folder another app
 * writes notes into, read through the Storage Access Framework, so NoteDown needs no storage permission and
 * sees only the folder the user picked.
 *
 * pick() → { uri, label }: the system folder picker; the grant (read and write, to delete what was read) is
 * kept across restarts. Rejects with "cancelled" when the user backs out.
 * list({ uri }) → { files: [{ id, name, modified, text }] }: the Markdown and text files directly in the
 * folder (no subfolders), at most MAX_FILES of at most MAX_BYTES each, as UTF-8. Rejects with "no-access"
 * when the grant is gone (the folder was deleted or access revoked).
 * remove({ uri, id }): deletes one file of the folder.
 */
@CapacitorPlugin(name = "FolderSource")
public class FolderSourcePlugin extends Plugin {

    private static final int MAX_FILES = 50;
    private static final long MAX_BYTES = 1024 * 1024;

    @PluginMethod
    public void pick(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "picked");
    }

    @ActivityCallback
    private void picked(PluginCall call, ActivityResult result) {
        Intent data = result.getData();
        Uri tree = data == null ? null : data.getData();
        if (tree == null) {
            call.reject("No folder chosen", "cancelled");
            return;
        }
        try {
            getContext().getContentResolver().takePersistableUriPermission(tree,
                Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (SecurityException e) {
            call.reject("The folder can't be kept", "no-access");
            return;
        }
        JSObject ret = new JSObject();
        ret.put("uri", tree.toString());
        ret.put("label", folderName(tree));
        call.resolve(ret);
    }

    @PluginMethod
    public void list(PluginCall call) {
        Uri tree = granted(call);
        if (tree == null) return;
        getBridge().execute(() -> {
            ContentResolver resolver = getContext().getContentResolver();
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
            String[] columns = {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_LAST_MODIFIED,
                DocumentsContract.Document.COLUMN_SIZE,
            };
            JSArray files = new JSArray();
            try (Cursor c = resolver.query(children, columns, null, null, null)) {
                while (c != null && c.moveToNext() && files.length() < MAX_FILES) {
                    String id = c.getString(0);
                    String name = c.getString(1);
                    if (name == null || DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(2))) continue;
                    if (!name.toLowerCase().matches(".*\\.(md|markdown|txt)$")) continue;
                    if (!c.isNull(4) && c.getLong(4) > MAX_BYTES) continue;
                    String text = read(resolver, DocumentsContract.buildDocumentUriUsingTree(tree, id));
                    if (text == null) continue;
                    JSObject file = new JSObject();
                    file.put("id", id);
                    file.put("name", name);
                    file.put("modified", c.isNull(3) ? 0 : c.getLong(3));
                    file.put("text", text);
                    files.put(file);
                }
            } catch (Exception e) {
                call.reject("The folder can't be read", "no-access");
                return;
            }
            JSObject ret = new JSObject();
            ret.put("files", files);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void remove(PluginCall call) {
        Uri tree = granted(call);
        if (tree == null) return;
        String id = call.getString("id");
        if (id == null) {
            call.reject("No file named", "invalid");
            return;
        }
        getBridge().execute(() -> {
            try {
                if (DocumentsContract.deleteDocument(getContext().getContentResolver(), DocumentsContract.buildDocumentUriUsingTree(tree, id))) {
                    call.resolve();
                } else {
                    call.reject("The file can't be deleted", "not-deleted");
                }
            } catch (Exception e) {
                call.reject("The file can't be deleted", "not-deleted");
            }
        });
    }

    // The folder of the call, while NoteDown still holds its grant; else rejects the call and returns null.
    private Uri granted(PluginCall call) {
        String uri = call.getString("uri");
        if (uri != null) {
            Uri tree = Uri.parse(uri);
            for (UriPermission p : getContext().getContentResolver().getPersistedUriPermissions()) {
                if (p.getUri().equals(tree) && p.isReadPermission()) return tree;
            }
        }
        call.reject("No access to the folder", "no-access");
        return null;
    }

    private String folderName(Uri tree) {
        Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
        try (Cursor c = getContext().getContentResolver().query(doc, new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst() && c.getString(0) != null) return c.getString(0);
        } catch (Exception e) {
            // fall back to the ID below
        }
        String id = DocumentsContract.getTreeDocumentId(tree);
        return id.substring(id.lastIndexOf(':') + 1);
    }

    private static String read(ContentResolver resolver, Uri uri) {
        try (InputStream in = resolver.openInputStream(uri)) {
            if (in == null) return null;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > MAX_BYTES) return null;
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }
}

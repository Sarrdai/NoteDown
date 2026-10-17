package io.github.sarrdai.notedown;

import android.content.pm.PackageManager;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.security.keystore.StrongBoxUnavailableException;
import android.util.AtomicFile;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The local vault's Android side (backlog #19, app/js/vault.js): the records live as files in the app's
 * private storage (files/vault/records, excluded from every backup), already encrypted by the web code; the
 * data key that encrypts them is sealed with an AES key of the Android Keystore (StrongBox where the device
 * has it, otherwise the TEE), which can't be read out of the device. Like Signal's database secret.
 *
 * dataKey() → { key: base64 of the 32-byte data key }, created on first use;
 * read({ name }) → { data: base64 | null }; write({ name, data }); remove({ name }); list() → { names };
 * clear() erases the records, the sealed key and the Keystore key (signing out).
 */
@CapacitorPlugin(name = "Vault")
public class VaultPlugin extends Plugin {

    private static final String ALIAS = "notedown-vault";
    private static final int IV_BYTES = 12;

    private File dir() {
        File d = new File(getContext().getFilesDir(), "vault");
        if (!d.isDirectory()) d.mkdirs();
        return d;
    }

    private File records() {
        File d = new File(dir(), "records");
        if (!d.isDirectory()) d.mkdirs();
        return d;
    }

    // Record names (e.g. "secret:file:<server>/<id>") as file names.
    private static String fileName(String name) {
        return Base64.encodeToString(name.getBytes(StandardCharsets.UTF_8), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    private static String recordName(String file) {
        return new String(Base64.decode(file, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING), StandardCharsets.UTF_8);
    }

    private static void writeAtomically(File file, byte[] bytes) throws Exception {
        AtomicFile f = new AtomicFile(file);
        FileOutputStream out = f.startWrite();
        try {
            out.write(bytes);
            f.finishWrite(out);
        } catch (Exception e) {
            f.failWrite(out);
            throw e;
        }
    }

    private SecretKey keystoreKey(KeyStore ks, boolean create) throws Exception {
        KeyStore.Entry entry = ks.getEntry(ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        if (!create) return null;
        boolean strongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            && getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE);
        if (strongBox) {
            try {
                return generate(true);
            } catch (StrongBoxUnavailableException e) {
                // falls back to the TEE
            }
        }
        return generate(false);
    }

    private static SecretKey generate(boolean strongBox) throws Exception {
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true);
        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) spec.setIsStrongBoxBacked(true);
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        gen.init(spec.build());
        return gen.generateKey();
    }

    @PluginMethod
    public void dataKey(PluginCall call) {
        byte[] raw = null;
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            File sealed = new File(dir(), "key.sealed");
            if (sealed.exists()) {
                SecretKey k = keystoreKey(ks, false);
                if (k == null) {
                    call.reject("The Keystore key of the local data is gone", "KEY_LOST");
                    return;
                }
                byte[] blob = new AtomicFile(sealed).readFully();
                Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
                c.init(Cipher.DECRYPT_MODE, k, new GCMParameterSpec(128, blob, 0, IV_BYTES));
                raw = c.doFinal(blob, IV_BYTES, blob.length - IV_BYTES);
            } else {
                SecretKey k = keystoreKey(ks, true);
                raw = new byte[32];
                new SecureRandom().nextBytes(raw);
                Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
                c.init(Cipher.ENCRYPT_MODE, k);
                byte[] iv = c.getIV();
                byte[] ct = c.doFinal(raw);
                byte[] blob = new byte[iv.length + ct.length];
                System.arraycopy(iv, 0, blob, 0, iv.length);
                System.arraycopy(ct, 0, blob, iv.length, ct.length);
                writeAtomically(sealed, blob);
            }
            JSObject ret = new JSObject();
            ret.put("key", Base64.encodeToString(raw, Base64.NO_WRAP));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not open the local data key", e);
        } finally {
            if (raw != null) Arrays.fill(raw, (byte) 0);
        }
    }

    @PluginMethod
    public void read(PluginCall call) {
        String name = call.getString("name");
        if (name == null) { call.reject("name is required"); return; }
        try {
            File f = new File(records(), fileName(name));
            JSObject ret = new JSObject();
            if (f.exists() || new File(f.getPath() + ".bak").exists()) {
                ret.put("data", Base64.encodeToString(new AtomicFile(f).readFully(), Base64.NO_WRAP));
            } else {
                ret.put("data", JSObject.NULL);
            }
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not read " + name, e);
        }
    }

    @PluginMethod
    public void write(PluginCall call) {
        String name = call.getString("name");
        String data = call.getString("data");
        if (name == null || data == null) { call.reject("name and data are required"); return; }
        try {
            writeAtomically(new File(records(), fileName(name)), Base64.decode(data, Base64.NO_WRAP));
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not write " + name, e);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String name = call.getString("name");
        if (name == null) { call.reject("name is required"); return; }
        new AtomicFile(new File(records(), fileName(name))).delete();
        call.resolve();
    }

    @PluginMethod
    public void list(PluginCall call) {
        JSArray names = new JSArray();
        String[] files = records().list();
        if (files != null) for (String f : files) if (!f.endsWith(".bak") && !f.endsWith(".new")) names.put(recordName(f));
        JSObject ret = new JSObject();
        ret.put("names", names);
        call.resolve(ret);
    }

    @PluginMethod
    public void clear(PluginCall call) {
        try {
            File[] files = records().listFiles();
            if (files != null) for (File f : files) f.delete();
            new AtomicFile(new File(dir(), "key.sealed")).delete();
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not erase the local data", e);
        }
    }
}

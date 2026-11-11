package app.mileagelog;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentSender;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Insets;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import com.google.android.gms.auth.GoogleAuthUtil;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Scope;
import com.google.android.gms.tasks.Tasks;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

/**
 * Thin native shell. The whole UI lives in assets/www (HTML/JS); this class provides what a
 * web page cannot do by itself: durable storage, printing, files, bill photos and cloud sync.
 */
public class MainActivity extends Activity {
    private static final int REQ_SAVE = 1, REQ_OPEN = 2, REQ_AUTH = 3,
            REQ_PHOTO_PICK = 5, REQ_PHOTO_CAMERA = 6, REQ_ZIP = 7;
    private static final String DATA_FILE = "mileage-log.json";
    private static final String BILLS_DIR = "bills";
    private static final String BILL_URL_PREFIX = "/android_asset/www/bills/";
    private static final int PHOTO_MAX_PX = 1600;
    private static final int RW = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;

    private WebView web;
    private SharedPreferences prefs;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private String pendingSaveContent;
    private Uri cameraUri;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("app", MODE_PRIVATE);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.navy));
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        // Keep content clear of the status/navigation bars and keyboard (edge-to-edge on Android 15+).
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Insets i = insets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                v.setPadding(i.left, i.top, i.right, i.bottom);
            } else {
                v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setTextZoom(100);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return true; // the app is a single local page; never navigate away from it
            }

            /** Serves bill photos from private storage for <img src="bills/NAME.jpg">. */
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String path = request.getUrl().getPath();
                if (path == null || !path.startsWith(BILL_URL_PREFIX)) return null;
                File f = billFile(path.substring(BILL_URL_PREFIX.length()));
                try {
                    if (f != null && f.exists()) {
                        return new WebResourceResponse("image/jpeg", null, new FileInputStream(f));
                    }
                } catch (IOException ignored) {
                }
                return new WebResourceResponse("image/jpeg", null, 404, "Not found", null,
                        new ByteArrayInputStream(new byte[0]));
            }
        });
        web.addJavascriptInterface(new Bridge(), "Android");
        web.loadUrl("file:///android_asset/www/index.html");
        requestSync(); // catch up on anything that could not be uploaded last time
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.handleBack ? window.handleBack() : false", handled -> {
            if (!"true".equals(handled)) finish();
        });
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        js("window.onSystemTheme && window.onSystemTheme(" + isNight(newConfig) + ")");
    }

    private static boolean isNight(Configuration c) {
        return (c.uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    private void js(final String code) {
        runOnUiThread(() -> web.evaluateJavascript(code, null));
    }

    // ------------------------------------------------------------------ local data file

    private File dataFile() {
        return new File(getFilesDir(), DATA_FILE);
    }

    private String readLocalData() {
        File f = dataFile();
        if (!f.exists()) return "";
        try (InputStream in = new FileInputStream(f)) {
            return new String(readAll(in), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "";
        }
    }

    private synchronized void writeLocalData(String json) {
        // Write to a temp file first so a crash mid-write can never corrupt the log.
        File tmp = new File(getFilesDir(), DATA_FILE + ".tmp");
        File dst = dataFile();
        try (OutputStream out = new FileOutputStream(tmp)) {
            out.write(json.getBytes(StandardCharsets.UTF_8));
            out.flush();
        } catch (IOException e) {
            return;
        }
        if (!tmp.renameTo(dst)) {
            dst.delete();
            tmp.renameTo(dst);
        }
    }

    // ------------------------------------------------------------------ bill photos

    /** Returns the file for a photo name, or null if the name is not one we generated. */
    private File billFile(String name) {
        if (name == null || !name.matches("[A-Za-z0-9_-]{1,60}\\.jpg")) return null;
        File dir = new File(getFilesDir(), BILLS_DIR);
        dir.mkdirs();
        return new File(dir, name);
    }

    /** Copies a picked/captured image into private storage, downscaled and upright. */
    private String importPhoto(Uri uri) throws IOException {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            BitmapFactory.decodeStream(in, null, bounds);
        }
        int sample = 1;
        while (Math.max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= PHOTO_MAX_PX) sample *= 2;
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = sample;
        Bitmap bmp;
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            bmp = BitmapFactory.decodeStream(in, null, opts);
        }
        if (bmp == null) throw new IOException("Not an image");

        int degrees = 0;
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            int o = new ExifInterface(in).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
            degrees = o == ExifInterface.ORIENTATION_ROTATE_90 ? 90
                    : o == ExifInterface.ORIENTATION_ROTATE_180 ? 180
                    : o == ExifInterface.ORIENTATION_ROTATE_270 ? 270 : 0;
        } catch (IOException | RuntimeException ignored) {
        }
        float scale = Math.min(1f, (float) PHOTO_MAX_PX / Math.max(bmp.getWidth(), bmp.getHeight()));
        if (scale < 1f || degrees != 0) {
            Matrix m = new Matrix();
            m.postScale(scale, scale);
            m.postRotate(degrees);
            bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
        }
        String name = "b" + System.currentTimeMillis() + ".jpg";
        try (OutputStream out = new FileOutputStream(billFile(name))) {
            bmp.compress(Bitmap.CompressFormat.JPEG, 82, out);
        }
        return name;
    }

    private void finishPhoto(final Uri uri, final boolean deleteSource) {
        io.execute(() -> {
            String name = null;
            try {
                name = importPhoto(uri);
            } catch (IOException | RuntimeException ignored) {
            }
            if (deleteSource) deleteQuietly(uri); // the copy in the app is the one we keep
            js("window.onPhotoAdded && window.onPhotoAdded(" + (name == null ? "null" : JSONObject.quote(name)) + ")");
        });
    }

    private void deleteQuietly(Uri uri) {
        try {
            getContentResolver().delete(uri, null, null);
        } catch (RuntimeException ignored) {
        }
    }

    // ------------------------------------------------------------------ Google Drive sync
    //
    // Sign-in uses Google Identity Services (authorize() with the drive.file scope), then plain
    // REST calls. In Drive the app keeps:   MilageTracker/mileage-log.json   and   MilageTracker/Bills/*.jpg
    // The phone is the source of truth for the log; bill photos are reconciled both ways.

    private static final String DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
    private static final String DRIVE_FOLDER = "MilageTracker";
    private static final String DRIVE_BILLS = "Bills";
    private static final String KEY_SYNCED = "driveSyncedPhotos";

    private final AtomicBoolean syncQueued = new AtomicBoolean(false);
    private volatile boolean syncBusy;

    private boolean cloudOn() {
        return prefs.getBoolean("cloudOn", false);
    }

    private String cloudStatusJson() {
        JSONObject o = new JSONObject();
        try {
            o.put("connected", cloudOn());
            o.put("account", prefs.getString("cloudAccount", ""));
            o.put("lastSync", prefs.getLong("cloudLastSync", 0));
            o.put("error", prefs.getString("cloudError", ""));
            o.put("busy", syncBusy);
        } catch (JSONException ignored) {
        }
        return o.toString();
    }

    private void notifyCloudStatus() {
        js("window.onCloudStatus && window.onCloudStatus(" + cloudStatusJson() + ")");
    }

    private void setCloudError(String message) {
        prefs.edit().putString("cloudError", message == null ? "" : message).apply();
    }

    private AuthorizationResult authorize() throws ExecutionException, InterruptedException {
        AuthorizationRequest request = AuthorizationRequest.builder()
                .setRequestedScopes(Collections.singletonList(new Scope(DRIVE_SCOPE)))
                .build();
        return Tasks.await(Identity.getAuthorizationClient(this).authorize(request));
    }

    /** Access token without showing any UI, or null if the user has to sign in / consent again. */
    private String silentToken() throws ExecutionException, InterruptedException {
        AuthorizationResult r = authorize();
        return r.hasResolution() ? null : r.getAccessToken();
    }

    /** "Connect Google Drive" tapped: sign in (showing Google's screens if needed), then link up. */
    private void cloudConnect() {
        io.execute(() -> {
            try {
                AuthorizationResult r = authorize();
                if (r.hasResolution() && r.getPendingIntent() != null) {
                    final PendingIntent consent = r.getPendingIntent();
                    runOnUiThread(() -> {
                        try {
                            startIntentSenderForResult(consent.getIntentSender(), REQ_AUTH, null, 0, 0, 0);
                        } catch (IntentSender.SendIntentException e) {
                            setCloudError("Could not open Google sign-in.");
                            notifyCloudStatus();
                        }
                    });
                } else {
                    onSignedIn(r.getAccessToken());
                }
            } catch (Exception e) {
                setCloudError(friendly(e));
                notifyCloudStatus();
            }
        });
    }

    /** Runs on the io thread once we hold a token for the first time. */
    private void onSignedIn(String token) {
        try {
            Drive drive = new Drive(token);
            String folder = ensureFolder(drive, "driveFolderId", DRIVE_FOLDER, null);
            prefs.edit().putBoolean("cloudOn", true).putString("cloudAccount", drive.email())
                    .putString("cloudError", "").apply();
            String dataId = drive.find(DATA_FILE, folder, false);
            if (dataId != null) {
                // Drive already has a log (new phone / reinstall): let the user choose which side wins.
                prefs.edit().putString("driveDataId", dataId).apply();
                String text = new String(drive.download(dataId), StandardCharsets.UTF_8);
                notifyCloudStatus();
                js("window.onCloudData && window.onCloudData(" + JSONObject.quote(text) + ")");
            } else {
                notifyCloudStatus();
                requestSync();
            }
        } catch (Exception e) {
            setCloudError(friendly(e));
            notifyCloudStatus();
        }
    }

    private String ensureFolder(Drive drive, String prefKey, String name, String parentId) throws IOException {
        String id = prefs.getString(prefKey, null);
        if (id != null) return id;
        id = drive.find(name, parentId, true);
        if (id == null) id = drive.createFolder(name, parentId);
        prefs.edit().putString(prefKey, id).apply();
        return id;
    }

    private void forgetDriveIds() {
        prefs.edit().remove("driveFolderId").remove("driveBillsId").remove("driveDataId").apply();
    }

    /** Queues one sync; calls made while one is already waiting are merged into it. */
    private void requestSync() {
        if (!cloudOn() || !syncQueued.compareAndSet(false, true)) return;
        io.execute(() -> {
            syncQueued.set(false);
            if (!cloudOn()) return;
            syncBusy = true;
            notifyCloudStatus();
            try {
                String token = silentToken();
                if (token == null) throw new IOException("Google sign-in has expired. Tap Connect to sign in again.");
                try {
                    syncOnce(new Drive(token));
                } catch (Drive.HttpError e) {
                    if (e.code == 401) {          // stale cached token: drop it and retry once
                        GoogleAuthUtil.clearToken(this, token);
                        token = silentToken();
                        if (token == null) throw new IOException("Google sign-in has expired. Tap Connect to sign in again.");
                    } else if (e.code == 404) {   // our folder/file was removed in Drive: recreate
                        forgetDriveIds();
                    } else {
                        throw e;
                    }
                    syncOnce(new Drive(token));
                }
                prefs.edit().putLong("cloudLastSync", System.currentTimeMillis()).putString("cloudError", "").apply();
            } catch (Exception e) {
                setCloudError(friendly(e));
            } finally {
                syncBusy = false;
                notifyCloudStatus();
            }
        });
    }

    private void syncOnce(Drive drive) throws IOException {
        String folder = ensureFolder(drive, "driveFolderId", DRIVE_FOLDER, null);
        String bills = ensureFolder(drive, "driveBillsId", DRIVE_BILLS, folder);

        // 1. the log itself: phone -> Drive
        byte[] data = readLocalData().getBytes(StandardCharsets.UTF_8);
        String dataId = prefs.getString("driveDataId", null);
        if (dataId == null) dataId = drive.find(DATA_FILE, folder, false);
        if (dataId == null) dataId = drive.create(DATA_FILE, folder, "application/json", data);
        else drive.update(dataId, "application/json", data);
        prefs.edit().putString("driveDataId", dataId).apply();

        // 2. bill photos: reconcile. "synced" remembers what this phone has already seen in Drive,
        //    which tells a photo deleted here (remove from Drive) from one added elsewhere (download).
        Map<String, String> remote = drive.list(bills);
        Set<String> local = new HashSet<>();
        File[] files = new File(getFilesDir(), BILLS_DIR).listFiles();
        if (files != null) for (File f : files) if (billFile(f.getName()) != null) local.add(f.getName());
        Set<String> synced = new HashSet<>(prefs.getStringSet(KEY_SYNCED, new HashSet<>()));
        boolean downloaded = false;

        for (Map.Entry<String, String> r : remote.entrySet()) {
            String name = r.getKey();
            File target = billFile(name);
            if (target == null || local.contains(name)) continue;
            if (synced.contains(name)) {
                drive.trash(r.getValue());
                synced.remove(name);
            } else {
                byte[] img = drive.download(r.getValue());
                try (OutputStream out = new FileOutputStream(target)) {
                    out.write(img);
                }
                synced.add(name);
                downloaded = true;
            }
            prefs.edit().putStringSet(KEY_SYNCED, new HashSet<>(synced)).apply();
        }
        for (String name : local) {
            if (!remote.containsKey(name)) {
                try (InputStream in = new FileInputStream(billFile(name))) {
                    drive.create(name, bills, "image/jpeg", readAll(in));
                }
            }
            if (synced.add(name)) prefs.edit().putStringSet(KEY_SYNCED, new HashSet<>(synced)).apply();
        }
        if (downloaded) js("window.onPhotosChanged && window.onPhotosChanged()");
    }

    private void cloudDownload() {
        io.execute(() -> {
            String text = "";
            try {
                String token = silentToken();
                if (token == null) throw new IOException("Google sign-in has expired. Tap Connect to sign in again.");
                Drive drive = new Drive(token);
                String folder = ensureFolder(drive, "driveFolderId", DRIVE_FOLDER, null);
                String dataId = drive.find(DATA_FILE, folder, false);
                if (dataId != null) text = new String(drive.download(dataId), StandardCharsets.UTF_8);
                setCloudError("");
            } catch (Exception e) {
                setCloudError(friendly(e));
                notifyCloudStatus();
                return;
            }
            js("window.onCloudData && window.onCloudData(" + JSONObject.quote(text) + ")");
        });
    }

    /** Turns sign-in / network / Drive failures into a sentence the user can act on. */
    private static String friendly(Throwable e) {
        if (e instanceof ExecutionException && e.getCause() != null) e = e.getCause();
        if (e instanceof ApiException) {
            int code = ((ApiException) e).getStatusCode();
            if (code == 10) return "Google sign-in is not set up for this app yet (OAuth client missing, or its package name / SHA-1 does not match).";
            if (code == 7) return "No internet connection. Will retry at the next change.";
            if (code == 16 || code == 12501) return "Sign-in was cancelled.";
            return "Google sign-in failed (code " + code + ").";
        }
        if (e instanceof Drive.HttpError) {
            Drive.HttpError h = (Drive.HttpError) e;
            if (h.code == 403 && h.body.contains("accessNotConfigured")) return "The Google Drive API is not enabled in your Google Cloud project.";
            if (h.code == 403 && h.body.contains("storageQuotaExceeded")) return "Your Google Drive is full.";
            return "Google Drive answered with error " + h.code + ".";
        }
        if (e instanceof UnknownHostException || e instanceof ConnectException || e instanceof SocketTimeoutException) {
            return "No internet connection. Will retry at the next change.";
        }
        return e.getMessage() != null ? e.getMessage() : "Sync failed.";
    }

    // ------------------------------------------------------------------ JS bridge

    /** Methods callable from the page as window.Android.*. They run on a background thread. */
    private class Bridge {
        @JavascriptInterface
        public String loadData() {
            return readLocalData();
        }

        @JavascriptInterface
        public void saveData(String json) {
            writeLocalData(json);
            requestSync();
        }

        @JavascriptInterface
        public boolean isDark() {
            return isNight(getResources().getConfiguration());
        }

        @JavascriptInterface
        public void print(final String title) {
            runOnUiThread(() -> {
                PrintManager pm = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                pm.print(title, web.createPrintDocumentAdapter(title), new PrintAttributes.Builder().build());
            });
        }

        @JavascriptInterface
        public void saveFile(String name, String mime, String content) {
            pendingSaveContent = content;
            startActivityForResult(createDocument(name, mime), REQ_SAVE);
        }

        /** Full backup: data plus bill photos in one .zip. */
        @JavascriptInterface
        public void saveBackupZip(String name) {
            startActivityForResult(createDocument(name, "application/zip"), REQ_ZIP);
        }

        @JavascriptInterface
        public void pickFile() {
            startActivityForResult(openDocument("*/*"), REQ_OPEN);
        }

        // --- bill photos
        @JavascriptInterface
        public void addPhoto(String source) {
            try {
                if ("camera".equals(source)) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Images.Media.DISPLAY_NAME, "bill_" + System.currentTimeMillis() + ".jpg");
                    v.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
                    cameraUri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
                    Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                    i.putExtra(MediaStore.EXTRA_OUTPUT, cameraUri);
                    i.addFlags(RW);
                    startActivityForResult(i, REQ_PHOTO_CAMERA);
                } else {
                    startActivityForResult(openDocument("image/*"), REQ_PHOTO_PICK);
                }
            } catch (RuntimeException e) { // no camera / gallery app available
                if (cameraUri != null) deleteQuietly(cameraUri);
                cameraUri = null;
                js("window.onPhotoAdded && window.onPhotoAdded(null)");
            }
        }

        @JavascriptInterface
        public void deletePhoto(String name) {
            File f = billFile(name);
            if (f != null) f.delete();
            requestSync(); // removes it from Drive too
        }

        @JavascriptInterface
        public void deleteAllPhotos() {
            File[] files = new File(getFilesDir(), BILLS_DIR).listFiles();
            if (files != null) for (File f : files) f.delete();
        }

        // --- cloud (Google Drive)
        @JavascriptInterface
        public String cloudStatus() {
            return cloudStatusJson();
        }

        @JavascriptInterface
        public void cloudConnect() {
            MainActivity.this.cloudConnect();
        }

        @JavascriptInterface
        public void cloudDisconnect() {
            prefs.edit().remove("cloudOn").remove("cloudAccount").remove("cloudLastSync").remove("cloudError")
                    .remove(KEY_SYNCED).apply();
            forgetDriveIds();
            notifyCloudStatus();
        }

        @JavascriptInterface
        public void cloudSyncNow() {
            requestSync();
        }

        @JavascriptInterface
        public void cloudRead() {
            cloudDownload();
        }
    }

    private static Intent createDocument(String name, String mime) {
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType(mime);
        i.putExtra(Intent.EXTRA_TITLE, name);
        return i;
    }

    private static Intent openDocument(String mime) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType(mime);
        return i;
    }

    // ------------------------------------------------------------------ results of pickers

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        final Uri uri = (resultCode == RESULT_OK && data != null) ? data.getData() : null;

        switch (requestCode) {
            case REQ_SAVE: {
                final String content = pendingSaveContent;
                pendingSaveContent = null;
                if (uri == null || content == null) return; // cancelled
                io.execute(() -> {
                    boolean ok = true;
                    try (OutputStream out = openForOverwrite(uri)) {
                        out.write(content.getBytes(StandardCharsets.UTF_8));
                    } catch (IOException | RuntimeException e) {
                        ok = false;
                    }
                    js("window.onFileSaved(" + ok + ")");
                });
                break;
            }
            case REQ_ZIP: {
                if (uri == null) return;
                io.execute(() -> {
                    boolean ok = true;
                    try (ZipOutputStream zip = new ZipOutputStream(openForOverwrite(uri))) {
                        zip.putNextEntry(new ZipEntry("data.json"));
                        zip.write(readLocalData().getBytes(StandardCharsets.UTF_8));
                        zip.closeEntry();
                        File[] photos = new File(getFilesDir(), BILLS_DIR).listFiles();
                        if (photos != null) {
                            for (File f : photos) {
                                zip.putNextEntry(new ZipEntry(BILLS_DIR + "/" + f.getName()));
                                try (InputStream in = new FileInputStream(f)) {
                                    copy(in, zip);
                                }
                                zip.closeEntry();
                            }
                        }
                    } catch (IOException | RuntimeException e) {
                        ok = false;
                    }
                    js("window.onFileSaved(" + ok + ")");
                });
                break;
            }
            case REQ_OPEN: {
                if (uri == null) return;
                io.execute(() -> {
                    String text = "";
                    try (InputStream in = getContentResolver().openInputStream(uri)) {
                        byte[] bytes = readAll(in);
                        text = isZip(bytes) ? unpackBackup(bytes) : new String(bytes, StandardCharsets.UTF_8);
                    } catch (IOException | RuntimeException ignored) {
                    }
                    js("window.onFilePicked(" + JSONObject.quote(text) + ")");
                });
                break;
            }
            case REQ_AUTH: {
                if (resultCode != RESULT_OK) {
                    setCloudError("Sign-in was cancelled.");
                    notifyCloudStatus();
                    return;
                }
                try {
                    final String token = Identity.getAuthorizationClient(this)
                            .getAuthorizationResultFromIntent(data).getAccessToken();
                    io.execute(() -> onSignedIn(token));
                } catch (ApiException e) {
                    setCloudError(friendly(e));
                    notifyCloudStatus();
                }
                break;
            }
            case REQ_PHOTO_PICK: {
                if (uri != null) finishPhoto(uri, false);
                break;
            }
            case REQ_PHOTO_CAMERA: {
                Uri shot = cameraUri;
                cameraUri = null;
                if (shot == null) return;
                if (resultCode == RESULT_OK) finishPhoto(shot, true);
                else deleteQuietly(shot); // cancelled: remove the empty placeholder
                break;
            }
            default:
                break;
        }
    }

    /** Opens a picked document for writing, replacing whatever it contained. */
    private OutputStream openForOverwrite(Uri uri) throws IOException {
        try {
            OutputStream out = getContentResolver().openOutputStream(uri, "wt");
            if (out != null) return out;
        } catch (IOException | RuntimeException ignored) {
            // some providers do not support truncate mode
        }
        OutputStream out = getContentResolver().openOutputStream(uri, "w");
        if (out == null) throw new IOException("Could not open the file");
        return out;
    }

    private static boolean isZip(byte[] b) {
        return b.length > 3 && b[0] == 'P' && b[1] == 'K';
    }

    /** Extracts bill photos from a backup .zip into private storage; returns its data.json text. */
    private String unpackBackup(byte[] bytes) throws IOException {
        String json = "";
        try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(bytes))) {
            ZipEntry e;
            while ((e = zip.getNextEntry()) != null) {
                String n = e.getName();
                if (n.equals("data.json")) {
                    json = new String(readAll(zip), StandardCharsets.UTF_8);
                } else if (n.startsWith(BILLS_DIR + "/")) {
                    File f = billFile(n.substring(BILLS_DIR.length() + 1)); // rejects unexpected names/paths
                    if (f != null) {
                        try (OutputStream out = new FileOutputStream(f)) {
                            copy(zip, out);
                        }
                    }
                }
            }
        }
        return json;
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] chunk = new byte[8192];
        int n;
        while ((n = in.read(chunk)) > 0) out.write(chunk, 0, n);
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        copy(in, buf);
        return buf.toByteArray();
    }
}

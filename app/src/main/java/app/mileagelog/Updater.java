package app.mileagelog;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Finds the newest published APK in the project's GitHub releases and downloads it. */
final class Updater {
    private static final String LATEST_URL =
            "https://api.github.com/repos/doonsMonk/MilageTracker/releases/latest";
    private static final String DOWNLOAD_PREFIX =
            "https://github.com/doonsMonk/MilageTracker/releases/download/";

    /** A published build. */
    static final class Release {
        String version; // "1.5"
        String url;     // direct APK download
        long size;      // bytes, 0 if unknown
    }

    interface Progress {
        void at(int percent);
    }

    private Updater() {
    }

    /** Returns the latest release that has an APK attached, or null if there is none. */
    static Release latest() throws IOException {
        HttpURLConnection c = open(LATEST_URL);
        c.setRequestProperty("Accept", "application/vnd.github+json");
        try {
            int code = c.getResponseCode();
            if (code == 404) return null; // no releases published
            if (code == 403 || code == 429) throw new IOException("GitHub is limiting requests right now. Try again in an hour.");
            if (code != 200) throw new IOException("GitHub answered with error " + code + ".");
            JSONObject o = new JSONObject(new String(readAll(c.getInputStream()), StandardCharsets.UTF_8));
            JSONArray assets = o.optJSONArray("assets");
            for (int i = 0; assets != null && i < assets.length(); i++) {
                JSONObject a = assets.getJSONObject(i);
                String url = a.optString("browser_download_url");
                if (a.optString("name").toLowerCase().endsWith(".apk") && url.startsWith(DOWNLOAD_PREFIX)) {
                    Release r = new Release();
                    r.version = o.optString("tag_name").replaceFirst("^[vV]", "");
                    r.url = url;
                    r.size = a.optLong("size");
                    return r;
                }
            }
            return null;
        } catch (JSONException e) {
            throw new IOException("Could not read the release information from GitHub.");
        } finally {
            c.disconnect();
        }
    }

    /** True when version {@code a} is higher than {@code b}; compares dotted numbers ("1.10" > "1.9"). */
    static boolean isNewer(String a, String b) {
        String[] x = a.split("\\."), y = b.split("\\.");
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            int p = part(x, i), q = part(y, i);
            if (p != q) return p > q;
        }
        return false;
    }

    private static int part(String[] parts, int i) {
        if (i >= parts.length) return 0;
        String digits = parts[i].replaceAll("[^0-9].*$", "");
        try {
            return digits.isEmpty() ? 0 : Integer.parseInt(digits);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    static void download(Release r, File target, Progress progress) throws IOException {
        HttpURLConnection c = open(r.url);
        try {
            if (c.getResponseCode() != 200) throw new IOException("Download failed (error " + c.getResponseCode() + ").");
            long total = r.size > 0 ? r.size : c.getContentLengthLong();
            long done = 0;
            int shown = -1;
            byte[] buf = new byte[64 * 1024];
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(target)) {
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    done += n;
                    int pct = total > 0 ? (int) Math.min(100, done * 100 / total) : 0;
                    if (pct != shown) progress.at(shown = pct);
                }
            }
            if (r.size > 0 && done != r.size) throw new IOException("The download was incomplete. Try again.");
        } finally {
            c.disconnect();
        }
    }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestProperty("User-Agent", "MilageTracker-Android");
        return c;
    }

    private static byte[] readAll(InputStream in) throws IOException {
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = s.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }
}

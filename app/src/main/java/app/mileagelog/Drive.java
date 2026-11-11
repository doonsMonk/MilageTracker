package app.mileagelog;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.ProtocolException;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * Minimal Google Drive v3 REST client (blocking; call from a background thread).
 * Works with the drive.file scope, i.e. only files this app created.
 */
final class Drive {
    static final String FOLDER_MIME = "application/vnd.google-apps.folder";
    private static final String API = "https://www.googleapis.com/drive/v3/files";
    private static final String UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

    /** A non-2xx answer from Drive. */
    static final class HttpError extends IOException {
        final int code;
        final String body;

        HttpError(int code, String body) {
            super("Drive error " + code);
            this.code = code;
            this.body = body;
        }
    }

    private final String token;

    Drive(String token) {
        this.token = token;
    }

    // ---------------------------------------------------------------- operations

    /** Id of the first non-trashed file/folder with this name (inside parentId, or anywhere if null). */
    String find(String name, String parentId, boolean folder) throws IOException {
        String q = "name = '" + name.replace("'", "\\'") + "' and trashed = false and mimeType "
                + (folder ? "=" : "!=") + " '" + FOLDER_MIME + "'"
                + (parentId != null ? " and '" + parentId + "' in parents" : "");
        JSONArray files = getJson(API + "?spaces=drive&fields=files(id)&q=" + enc(q)).optJSONArray("files");
        return files != null && files.length() > 0 ? files.optJSONObject(0).optString("id", null) : null;
    }

    String createFolder(String name, String parentId) throws IOException {
        JSONObject meta = metadata(name, parentId);
        put(meta, "mimeType", FOLDER_MIME);
        return idOf(send("POST", API + "?fields=id", "application/json; charset=UTF-8", bytes(meta.toString())));
    }

    /** name -> id of every non-trashed file directly inside a folder. */
    Map<String, String> list(String folderId) throws IOException {
        Map<String, String> out = new HashMap<>();
        String page = null;
        do {
            String url = API + "?spaces=drive&pageSize=1000&fields=nextPageToken,files(id,name)&q="
                    + enc("'" + folderId + "' in parents and trashed = false")
                    + (page != null ? "&pageToken=" + enc(page) : "");
            JSONObject res = getJson(url);
            JSONArray files = res.optJSONArray("files");
            for (int i = 0; files != null && i < files.length(); i++) {
                JSONObject f = files.optJSONObject(i);
                out.put(f.optString("name"), f.optString("id"));
            }
            page = res.optString("nextPageToken", null);
        } while (page != null && !page.isEmpty());
        return out;
    }

    /** Creates a file with content; returns its id. */
    String create(String name, String parentId, String mime, byte[] data) throws IOException {
        String boundary = "mileagelog" + System.nanoTime();
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        body.write(bytes("--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"
                + metadata(name, parentId) + "\r\n--" + boundary + "\r\nContent-Type: " + mime + "\r\n\r\n"));
        body.write(data);
        body.write(bytes("\r\n--" + boundary + "--\r\n"));
        return idOf(send("POST", UPLOAD + "?uploadType=multipart&fields=id",
                "multipart/related; boundary=" + boundary, body.toByteArray()));
    }

    /** Replaces the content of an existing file. */
    void update(String fileId, String mime, byte[] data) throws IOException {
        send("PATCH", UPLOAD + "/" + fileId + "?uploadType=media&fields=id", mime, data);
    }

    byte[] download(String fileId) throws IOException {
        return send("GET", API + "/" + fileId + "?alt=media", null, null);
    }

    /** Moves a file to the Drive bin (recoverable for 30 days). */
    void trash(String fileId) throws IOException {
        send("PATCH", API + "/" + fileId + "?fields=id", "application/json; charset=UTF-8", bytes("{\"trashed\":true}"));
    }

    /** E-mail address of the signed-in account, or "" if it cannot be read. */
    String email() {
        try {
            JSONObject user = getJson("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)").optJSONObject("user");
            return user == null ? "" : user.optString("emailAddress", "");
        } catch (IOException e) {
            return "";
        }
    }

    // ---------------------------------------------------------------- plumbing

    private JSONObject getJson(String url) throws IOException {
        try {
            return new JSONObject(new String(send("GET", url, null, null), StandardCharsets.UTF_8));
        } catch (JSONException e) {
            throw new IOException("Unexpected answer from Drive");
        }
    }

    private static String idOf(byte[] response) throws IOException {
        try {
            return new JSONObject(new String(response, StandardCharsets.UTF_8)).getString("id");
        } catch (JSONException e) {
            throw new IOException("Unexpected answer from Drive");
        }
    }

    private static JSONObject metadata(String name, String parentId) {
        JSONObject meta = new JSONObject();
        put(meta, "name", name);
        if (parentId != null) put(meta, "parents", new JSONArray().put(parentId));
        return meta;
    }

    private static void put(JSONObject o, String key, Object value) {
        try {
            o.put(key, value);
        } catch (JSONException ignored) {
        }
    }

    private byte[] send(String method, String url, String contentType, byte[] body) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(20000);
            c.setReadTimeout(60000);
            try {
                c.setRequestMethod(method);
            } catch (ProtocolException e) { // PATCH not accepted by this HTTP stack
                c.setRequestMethod("POST");
                c.setRequestProperty("X-HTTP-Method-Override", method);
            }
            c.setRequestProperty("Authorization", "Bearer " + token);
            if (body != null) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", contentType);
                c.setFixedLengthStreamingMode(body.length);
                try (OutputStream out = c.getOutputStream()) {
                    out.write(body);
                }
            }
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            byte[] response = in == null ? new byte[0] : readAll(in);
            if (code >= 400) throw new HttpError(code, new String(response, StandardCharsets.UTF_8));
            return response;
        } finally {
            c.disconnect();
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        try (InputStream src = in) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = src.read(chunk)) > 0) buf.write(chunk, 0, n);
            return buf.toByteArray();
        }
    }

    private static byte[] bytes(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }

    private static String enc(String s) throws IOException {
        return URLEncoder.encode(s, "UTF-8");
    }
}

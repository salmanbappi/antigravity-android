package com.agy.oauth;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * Direct GitHub OAuth 2.0 Device Authorization Grant (RFC 8628) client.
 *
 * <p>Talks strictly to GitHub's official {@code /login/device/code} and
 * {@code /login/oauth/access_token} endpoints using a public client ID with
 * no client secret and no intermediary proxy. Access tokens and device codes
 * are never written to logs.</p>
 */
public final class GitHubDeviceAuth {

    private static final String TAG = "GitHubDeviceAuth";

    public static final String DEVICE_CODE_URL = "https://github.com/login/device/code";
    public static final String ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
    public static final String DEFAULT_VERIFICATION_URI = "https://github.com/login/device";

    /** GitHub CLI public OAuth App client ID (supports Device Flow without client_secret). */
    public static final String DEFAULT_CLIENT_ID = "178c6fc778ccc68e1d6a";
    public static final String DEFAULT_SCOPE = "repo read:org gist workflow";
    private static final String GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

    private static final String USER_AGENT = "Antigravity-Android/GitHubDeviceAuth";
    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 15000;
    private static final int MAX_RESPONSE_BYTES = 64 * 1024;
    private static final int MAX_DEVICE_CODE_LEN = 512;
    private static final int MAX_USER_CODE_LEN = 32;

    private GitHubDeviceAuth() {
    }

    /**
     * Initiates GitHub Device Flow by requesting a {@code device_code} and {@code user_code}
     * directly from {@link #DEVICE_CODE_URL}.
     */
    public static JSONObject startDeviceFlow(String scope) {
        String effectiveScope = sanitizeScope(scope);
        try {
            String form = "client_id=" + urlEncode(DEFAULT_CLIENT_ID)
                    + "&scope=" + urlEncode(effectiveScope);
            HttpJsonResult res = postForm(DEVICE_CODE_URL, form);
            if (res.json == null) {
                return errorJson("network_error",
                        "Unexpected response from GitHub (HTTP " + res.statusCode + ")");
            }

            String apiError = res.json.optString("error", "").trim();
            if (!apiError.isEmpty()) {
                Log.w(TAG, "startDeviceFlow error=" + apiError + " http=" + res.statusCode);
                return errorJson(apiError,
                        res.json.optString("error_description", "GitHub rejected device code request"));
            }

            String deviceCode = res.json.optString("device_code", "").trim();
            String userCode = res.json.optString("user_code", "").trim();
            if (deviceCode.isEmpty() || userCode.isEmpty()) {
                Log.w(TAG, "startDeviceFlow missing fields http=" + res.statusCode);
                return errorJson("invalid_response", "GitHub did not return a device code");
            }

            String verificationUri = sanitizeVerificationUri(
                    res.json.optString("verification_uri", DEFAULT_VERIFICATION_URI));
            int expiresIn = res.json.optInt("expires_in", 900);
            if (expiresIn <= 0) {
                expiresIn = 900;
            }
            int interval = res.json.optInt("interval", 5);
            if (interval < 1) {
                interval = 5;
            }

            Log.i(TAG, "startDeviceFlow started (expires_in=" + expiresIn + "s interval=" + interval + "s)");
            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("device_code", deviceCode);
            out.put("user_code", userCode);
            out.put("verification_uri", verificationUri);
            out.put("expires_in", expiresIn);
            out.put("interval", interval);
            return out;
        } catch (Exception e) {
            Log.w(TAG, "startDeviceFlow failed: " + e.getClass().getSimpleName());
            return errorJson("network_error", safeExceptionMessage(e));
        }
    }

    /**
     * Polls {@link #ACCESS_TOKEN_URL} once for the given {@code deviceCode}.
     * Never logs the returned access token or raw response body.
     */
    public static JSONObject pollDeviceFlow(String deviceCode) {
        String trimmed = deviceCode != null ? deviceCode.trim() : "";
        if (trimmed.isEmpty() || trimmed.length() > MAX_DEVICE_CODE_LEN
                || trimmed.indexOf('\r') >= 0 || trimmed.indexOf('\n') >= 0) {
            return errorJson("invalid_request", "Missing or invalid device code");
        }

        try {
            String form = "client_id=" + urlEncode(DEFAULT_CLIENT_ID)
                    + "&device_code=" + urlEncode(trimmed)
                    + "&grant_type=" + urlEncode(GRANT_TYPE);
            HttpJsonResult res = postForm(ACCESS_TOKEN_URL, form);
            if (res.json == null) {
                return networkPollError("Unexpected response from GitHub (HTTP " + res.statusCode + ")");
            }

            String accessToken = res.json.optString("access_token", "").trim();
            if (!accessToken.isEmpty()) {
                Log.i(TAG, "pollDeviceFlow completed (token acquired)");
                JSONObject out = new JSONObject();
                out.put("ok", true);
                out.put("status", "complete");
                out.put("access_token", accessToken);
                out.put("token_type", res.json.optString("token_type", "bearer"));
                out.put("scope", res.json.optString("scope", ""));
                return out;
            }

            String apiError = res.json.optString("error", "").trim();
            String errorDesc = res.json.optString("error_description", "").trim();
            if ("authorization_pending".equals(apiError)) {
                JSONObject out = new JSONObject();
                out.put("ok", true);
                out.put("status", "pending");
                out.put("error", apiError);
                return out;
            }
            if ("slow_down".equals(apiError)) {
                int nextInterval = res.json.optInt("interval", 0);
                Log.i(TAG, "pollDeviceFlow slow_down"
                        + (nextInterval > 0 ? (" interval=" + nextInterval + "s") : ""));
                JSONObject out = new JSONObject();
                out.put("ok", true);
                out.put("status", "slow_down");
                out.put("error", apiError);
                if (nextInterval > 0) {
                    out.put("interval", nextInterval);
                }
                return out;
            }
            if (!apiError.isEmpty()) {
                Log.i(TAG, "pollDeviceFlow terminal error=" + apiError);
                JSONObject out = new JSONObject();
                out.put("ok", true);
                out.put("status", "error");
                out.put("error", apiError);
                out.put("error_description", errorDesc);
                return out;
            }

            return networkPollError("Empty response from GitHub (HTTP " + res.statusCode + ")");
        } catch (Exception e) {
            Log.w(TAG, "pollDeviceFlow network failure: " + e.getClass().getSimpleName());
            return networkPollError(safeExceptionMessage(e));
        }
    }

    /**
     * Opens GitHub's device verification page in the external browser.
     * Strictly locked to {@code https://github.com/login/device} (never opens arbitrary URLs).
     */
    public static boolean openVerificationUrl(Context context, String verificationUri) {
        if (context == null) {
            return false;
        }
        String safeUrl = sanitizeVerificationUri(verificationUri);
        return new CustomTabLauncher().openInBrowser(context, safeUrl);
    }

    /** Copies the short GitHub user verification code to Android's clipboard on the UI thread. */
    public static boolean copyUserCode(final Context context, String userCode) {
        if (context == null || userCode == null) {
            return false;
        }
        final String trimmed = userCode.trim();
        if (trimmed.isEmpty() || trimmed.length() > MAX_USER_CODE_LEN
                || trimmed.indexOf('\r') >= 0 || trimmed.indexOf('\n') >= 0) {
            return false;
        }
        final Context appCtx = context.getApplicationContext();
        Handler mainHandler = new Handler(Looper.getMainLooper());
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    ClipboardManager cm = (ClipboardManager) appCtx.getSystemService(Context.CLIPBOARD_SERVICE);
                    if (cm != null) {
                        cm.setPrimaryClip(ClipData.newPlainText("GitHub Device Code", trimmed));
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "copyUserCode failed: " + t.getClass().getSimpleName());
                }
            }
        });
        return true;
    }

    static String sanitizeVerificationUri(String candidate) {
        if (candidate == null) {
            return DEFAULT_VERIFICATION_URI;
        }
        String trimmed = candidate.trim();
        if (DEFAULT_VERIFICATION_URI.equals(trimmed)) {
            return trimmed;
        }
        if (trimmed.startsWith(DEFAULT_VERIFICATION_URI + "?")) {
            // Reject whitespace, control chars, or credentials
            for (int i = 0; i < trimmed.length(); i++) {
                char c = trimmed.charAt(i);
                if (c <= 0x20 || c >= 0x7f || c == '@') {
                    return DEFAULT_VERIFICATION_URI;
                }
            }
            return trimmed;
        }
        return DEFAULT_VERIFICATION_URI;
    }

    private static String sanitizeScope(String scope) {
        if (scope == null) {
            return DEFAULT_SCOPE;
        }
        String cleaned = scope.replace('\r', ' ').replace('\n', ' ').trim();
        return cleaned.isEmpty() ? DEFAULT_SCOPE : cleaned;
    }

    private static HttpJsonResult postForm(String urlStr, String formBody) throws IOException {
        if (!DEVICE_CODE_URL.equals(urlStr) && !ACCESS_TOKEN_URL.equals(urlStr)) {
            throw new IOException("Disallowed endpoint");
        }
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setInstanceFollowRedirects(false);
            conn.setDoOutput(true);
            conn.setUseCaches(false);
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=utf-8");
            conn.setRequestProperty("User-Agent", USER_AGENT);

            byte[] payload = formBody.getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(payload.length);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(payload);
                out.flush();
            }

            int status = conn.getResponseCode();
            InputStream stream = (status >= 200 && status < 400)
                    ? conn.getInputStream()
                    : conn.getErrorStream();
            String body = readBoundedUtf8(stream, MAX_RESPONSE_BYTES);
            JSONObject parsed = parseResponseBody(body);
            return new HttpJsonResult(status, parsed);
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private static String readBoundedUtf8(InputStream stream, int maxBytes) throws IOException {
        if (stream == null) {
            return "";
        }
        try (InputStream in = stream) {
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int total = 0;
            int read;
            while ((read = in.read(buf)) != -1) {
                int allowed = Math.min(read, maxBytes - total);
                if (allowed > 0) {
                    baos.write(buf, 0, allowed);
                    total += allowed;
                }
                if (total >= maxBytes) {
                    break;
                }
            }
            return new String(baos.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static JSONObject parseResponseBody(String body) {
        if (body == null) {
            return null;
        }
        String trimmed = body.trim();
        if (trimmed.isEmpty()) {
            return null;
        }
        if (trimmed.startsWith("{")) {
            try {
                return new JSONObject(trimmed);
            } catch (Exception ignored) {
                return null;
            }
        }
        // Fallback: parse application/x-www-form-urlencoded if GitHub omits JSON
        if (trimmed.indexOf('=') >= 0 && !trimmed.startsWith("<")) {
            JSONObject obj = new JSONObject();
            String[] pairs = trimmed.split("&");
            for (String pair : pairs) {
                int eq = pair.indexOf('=');
                if (eq <= 0) {
                    continue;
                }
                try {
                    String k = URLDecoder.decode(pair.substring(0, eq), "UTF-8");
                    String v = URLDecoder.decode(pair.substring(eq + 1), "UTF-8");
                    obj.put(k, v);
                } catch (Exception ignored) {
                }
            }
            return obj.length() > 0 ? obj : null;
        }
        return null;
    }

    private static String urlEncode(String value) throws IOException {
        return URLEncoder.encode(value, "UTF-8");
    }

    private static JSONObject errorJson(String error, String description) {
        JSONObject out = new JSONObject();
        try {
            out.put("ok", false);
            out.put("error", error != null ? error : "error");
            out.put("error_description", description != null ? description : "");
        } catch (Exception ignored) {
        }
        return out;
    }

    private static JSONObject networkPollError(String description) {
        JSONObject out = new JSONObject();
        try {
            out.put("ok", false);
            out.put("status", "network_error");
            out.put("error", "network_error");
            out.put("error_description", description != null ? description : "Network error");
        } catch (Exception ignored) {
        }
        return out;
    }

    private static String safeExceptionMessage(Exception e) {
        String msg = e != null ? e.getMessage() : null;
        if (msg == null || msg.trim().isEmpty()) {
            return "Unable to reach github.com";
        }
        return com.agy.util.SensitiveDataRedactor.redactLine(msg);
    }

    private static final class HttpJsonResult {
        final int statusCode;
        final JSONObject json;

        HttpJsonResult(int statusCode, JSONObject json) {
            this.statusCode = statusCode;
            this.json = json;
        }
    }
}

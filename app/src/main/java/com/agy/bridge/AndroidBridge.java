package com.agy.bridge;

import android.content.Context;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import com.agy.fs.ProjectFolderDeleter;
import com.agy.oauth.GitHubDeviceAuth;
import com.agy.runtime.RuntimeManager;
import com.agy.shell.RootBridge;
import com.agy.shell.ShizukuBridge;
import com.agy.theme.ThemeManager;
import com.agy.ui.MainActivity;

import org.json.JSONObject;

import java.lang.ref.WeakReference;
import java.nio.charset.Charset;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;

/**
 * Minimal, low-privilege JavaScript bridge for the app UI. It is visible to
 * embedded frames, so shell, notification, and arbitrary URL capabilities must
 * not be exposed here. Native-only getters below are intentionally unannotated.
 */
public final class AndroidBridge {

    private final Context appContext;
    private final UiBridge ui = new UiBridge();
    private final ThemeBridge themeBridge;
    private final EngineBridge engine;
    private final EngineConfigJson config;
    private final String blobBridgeToken = createBlobBridgeToken();
    private final ExecutorService githubAuthExecutor = Executors.newFixedThreadPool(2, new ThreadFactory() {
        @Override
        public Thread newThread(Runnable r) {
            Thread t = new Thread(r, "AgyGitHubDeviceAuth");
            t.setDaemon(true);
            return t;
        }
    });
    private final ExecutorService projectDeleteExecutor = Executors.newSingleThreadExecutor(new ThreadFactory() {
        @Override
        public Thread newThread(Runnable r) {
            Thread t = new Thread(r, "AgyProjectFolderDelete");
            t.setDaemon(true);
            return t;
        }
    });
    private volatile WeakReference<MainActivity> activityRef;

    public AndroidBridge(Context context, RuntimeManager runtime,
                         ShizukuBridge shizuku, ThemeManager theme) {
        this(context, runtime, shizuku, RootBridge.getShared(context), theme);
    }

    public AndroidBridge(Context context, RuntimeManager runtime,
                         ShizukuBridge shizuku, RootBridge root, ThemeManager theme) {
        this.appContext = context.getApplicationContext();
        this.themeBridge = new ThemeBridge(theme);
        this.engine = new EngineBridge(runtime);
        this.config = new EngineConfigJson(this.appContext, runtime, engine, shizuku, root, themeBridge);
    }

    /** Host activity, used to dismiss the native splash once the UI has painted. */
    public void setActivity(MainActivity activity) {
        this.activityRef = activity != null ? new WeakReference<MainActivity>(activity) : null;
        ui.setActivity(activity);
    }

    @JavascriptInterface
    public void onUiReady(String token) {
        if (matchesNativeBridgeToken(token)) {
            ui.onUiReady();
        }
    }

    @JavascriptInterface
    public void openDirectoryPicker(String token) {
        if (!matchesNativeBridgeToken(token)) {
            return;
        }
        final MainActivity act = activityRef != null ? activityRef.get() : MainActivity.activeActivity;
        if (act != null) {
            act.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    act.launchDirectoryPicker();
                }
            });
        }
    }

    @JavascriptInterface
    public void onUiError(String token, final String errorMessage) {
        if (matchesNativeBridgeToken(token)) {
            ui.onUiError(errorMessage);
        }
    }

    @JavascriptInterface
    public boolean setTheme(String token, String mode) {
        return matchesNativeBridgeToken(token) && themeBridge.setTheme(mode);
    }

    @JavascriptInterface
    public boolean setThemeByUser(String token, final String mode) {
        return matchesNativeBridgeToken(token) && themeBridge.setThemeByUser(mode);
    }

    @JavascriptInterface
    public void onVisualThemeChanged(String token, String visual) {
        if (matchesNativeBridgeToken(token)) {
            themeBridge.onVisualThemeChanged(visual);
        }
    }

    @JavascriptInterface
    public String getTheme() {
        return themeBridge.getTheme();
    }

    @JavascriptInterface
    public boolean isDesktopMode() {
        return ui.isDesktopMode();
    }

    @JavascriptInterface
    public void setDesktopMode(String token, boolean enabled) {
        if (matchesNativeBridgeToken(token)) {
            ui.setDesktopMode(enabled);
        }
    }

    // Native-only helpers used while preparing the trusted app document.
    public boolean isEngineReady() {
        return engine.isReady();
    }

    public int getEnginePort() {
        return engine.getPort();
    }

    public String getEngineBaseUrl() {
        return engine.getBaseUrl();
    }

    public String getCsrfToken() {
        return engine.getCsrfToken();
    }

    public String getConfig() {
        return config.get();
    }

    /** Native-only token inserted into the trusted top-level document. */
    public String getBlobBridgeToken() {
        return blobBridgeToken;
    }

    /**
     * Posts a native Android notification when the agent completes a task or requires
     * action while the host activity is backgrounded. Guarded by the top-level document token.
     */
    @JavascriptInterface
    public void notifyAgentEvent(String token, String eventType, String title, String body) {
        notifyAgentEventRich(token, eventType, title, body, null, null, false);
    }

    /**
     * Posts a native Android notification with conversation deep-link metadata when
     * the agent completes a task, replies, or needs input while backgrounded.
     */
    @JavascriptInterface
    public void notifyAgentEventRich(String token, String eventType, String title, String body,
                                     String conversationId, String notificationId, boolean silent) {
        if (!matchesNativeBridgeToken(token)) {
            return;
        }
        if (MainActivity.isInForeground()) {
            return;
        }
        String tag = (eventType != null && !eventType.trim().isEmpty())
                ? ("agy_agent_" + eventType.trim()) : "agy_agent_done";
        com.agy.gateway.handlers.NotificationHandler.postAgentAlert(
                appContext, tag, title, body, conversationId, silent);
    }

    /** Returns true iff MainActivity is currently resumed in the foreground. */
    @JavascriptInterface
    public boolean isInForeground() {
        return MainActivity.isInForeground();
    }

    /** Opens Android's per-app notification settings screen. */
    @JavascriptInterface
    public void openNotificationSettings(String token) {
        if (!matchesNativeBridgeToken(token)) {
            return;
        }
        com.agy.gateway.handlers.NotificationHandler.openNotificationSettings(appContext);
    }

    /**
     * Checks clipboard image MIME metadata without reading clip content, avoiding
     * Android 12+ clipboard toast notifications unless an image is actually present.
     */
    @JavascriptInterface
    public boolean hasClipboardImage(String token) {
        if (!matchesNativeBridgeToken(token)) {
            return false;
        }
        return com.agy.ui.webview.ClipboardImageReader.hasClipboardImage(appContext);
    }

    /**
     * Reads, downscales, and delivers a clipboard image asynchronously on a background
     * thread to avoid blocking the WebView JS thread.
     */
    @JavascriptInterface
    public void requestClipboardImagePaste(String token) {
        if (!matchesNativeBridgeToken(token)) {
            return;
        }
        final MainActivity act = activityRef != null ? activityRef.get() : MainActivity.activeActivity;
        final android.webkit.WebView wv = act != null ? act.getWebView() : null;
        if (wv == null) {
            return;
        }
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                com.agy.ui.webview.ClipboardImageReader.ImageData img =
                        com.agy.ui.webview.ClipboardImageReader.readFromClipboard(appContext);
                com.agy.ui.webview.AgyWebView.dispatchImageToWebView(wv, img);
            }
        }, "AgyClipImagePaste");
        t.setDaemon(true);
        t.start();
    }

    /** Reads an image URI from Android's clipboard for scripts holding the top-level token. */
    @JavascriptInterface
    public String readClipboardImage(String token) {
        if (!matchesNativeBridgeToken(token)) {
            return "";
        }
        com.agy.ui.webview.ClipboardImageReader.ImageData img =
                com.agy.ui.webview.ClipboardImageReader.readFromClipboard(appContext);
        return img != null ? img.toJson().toString() : "";
    }

    /** Saves a downloaded blob only for scripts holding the top-level document token. */
    @JavascriptInterface
    public void saveBlob(String token, String base64Data, String filename, String mimeType) {
        if (!matchesNativeBridgeToken(token)) {
            return;
        }
        final MainActivity act = activityRef != null ? activityRef.get() : MainActivity.activeActivity;
        if (act != null) {
            com.agy.ui.download.FileDownloader.handleBlobData(
                    act, base64Data, filename, mimeType);
        }
    }

    /**
     * Starts GitHub OAuth Device Flow asynchronously (POST https://github.com/login/device/code)
     * and delivers the JSON response to {@code window.__agGitHubDeviceAuthCallback(reqId, json)}.
     */
    @JavascriptInterface
    public void startGitHubDeviceAuth(String token, final String reqId, final String scope) {
        if (!matchesNativeBridgeToken(token) || reqId == null || reqId.trim().isEmpty()) {
            return;
        }
        githubAuthExecutor.execute(new Runnable() {
            @Override
            public void run() {
                JSONObject res = GitHubDeviceAuth.startDeviceFlow(scope);
                dispatchGitHubDeviceAuthCallback(reqId, res);
            }
        });
    }

    /**
     * Polls GitHub OAuth Device Flow asynchronously (POST https://github.com/login/oauth/access_token)
     * and delivers the JSON response to {@code window.__agGitHubDeviceAuthCallback(reqId, json)}.
     */
    @JavascriptInterface
    public void pollGitHubDeviceAuth(String token, final String reqId, final String deviceCode) {
        if (!matchesNativeBridgeToken(token) || reqId == null || reqId.trim().isEmpty()) {
            return;
        }
        githubAuthExecutor.execute(new Runnable() {
            @Override
            public void run() {
                JSONObject res = GitHubDeviceAuth.pollDeviceFlow(deviceCode);
                dispatchGitHubDeviceAuthCallback(reqId, res);
            }
        });
    }

    /** Opens GitHub's device verification page (strictly restricted to github.com/login/device). */
    @JavascriptInterface
    public boolean openGitHubDevicePage(String token, String verificationUri) {
        if (!matchesNativeBridgeToken(token)) {
            return false;
        }
        return GitHubDeviceAuth.openVerificationUrl(appContext, verificationUri);
    }

    /** Copies the GitHub device user code to Android's clipboard on the UI thread. */
    @JavascriptInterface
    public boolean copyGitHubDeviceCode(String token, String userCode) {
        if (!matchesNativeBridgeToken(token)) {
            return false;
        }
        return GitHubDeviceAuth.copyUserCode(appContext, userCode);
    }

    private void dispatchGitHubDeviceAuthCallback(final String reqId, final JSONObject result) {
        final MainActivity act = activityRef != null ? activityRef.get() : MainActivity.activeActivity;
        final WebView wv = act != null ? act.getWebView() : null;
        if (wv == null || reqId == null || result == null) {
            return;
        }
        final String payloadStr = result.toString();
        wv.post(new Runnable() {
            @Override
            public void run() {
                try {
                    String js = "window.__agGitHubDeviceAuthCallback && window.__agGitHubDeviceAuthCallback("
                            + JSONObject.quote(reqId) + ","
                            + JSONObject.quote(payloadStr) + ");";
                    wv.evaluateJavascript(js, null);
                } catch (Throwable ignored) {
                }
            }
        });
    }

    /** Returns sanitized saved account summaries for the top-level UI document. */
    @JavascriptInterface
    public String getSavedAccounts(String token) {
        if (!matchesNativeBridgeToken(token)) {
            return "[]";
        }
        return com.agy.oauth.AccountVaultStore.listAccountsJson(appContext);
    }

    /** Syncs the currently active OAuth token and optional UI profile metadata into the vault. */
    @JavascriptInterface
    public String syncCurrentAccount(String token, String profileJson) {
        if (!matchesNativeBridgeToken(token)) {
            return "[]";
        }
        return com.agy.oauth.AccountVaultStore.syncCurrentAccount(appContext, profileJson);
    }

    /** Atomically switches the active OAuth token on disk to the selected saved account. */
    @JavascriptInterface
    public String activateSavedAccount(String token, String accountId, String outgoingProfileJson) {
        if (!matchesNativeBridgeToken(token)) {
            return "{\"ok\":false,\"error\":\"Unauthorized bridge call\"}";
        }
        return com.agy.oauth.AccountVaultStore.activateAccount(appContext, accountId, outgoingProfileJson);
    }

    /** Removes a saved account from the persistent vault. */
    @JavascriptInterface
    public String removeSavedAccount(String token, String accountId) {
        if (!matchesNativeBridgeToken(token)) {
            return "[]";
        }
        return com.agy.oauth.AccountVaultStore.removeAccount(appContext, accountId);
    }

    /**
     * Safely deletes a local project directory on a background executor after strict
     * token and path-safety validation. Returns JSON {@code {ok, path, error}}.
     */
    @JavascriptInterface
    public String deleteProjectFolder(String token, String rawPath) {
        if (!matchesNativeBridgeToken(token)) {
            return ProjectFolderDeleter.buildJson(false, "", "Unauthorized bridge call");
        }
        final ProjectFolderDeleter.ValidationResult validation =
                ProjectFolderDeleter.validateTarget(appContext, rawPath);
        if (!validation.ok) {
            return ProjectFolderDeleter.buildJson(false, validation.canonicalPath, validation.error);
        }
        projectDeleteExecutor.execute(new Runnable() {
            @Override
            public void run() {
                ProjectFolderDeleter.deleteValidatedDirectory(
                        validation.canonicalDir, validation.canonicalPath);
            }
        });
        return ProjectFolderDeleter.buildJson(true, validation.canonicalPath, "");
    }

    /** Cleanly restarts the core service and reloads WebView if hot-swap verification requires it. */
    @JavascriptInterface
    public void restartCoreForAccountSwitch(String token) {
        if (!matchesNativeBridgeToken(token)) {
            return;
        }
        final MainActivity act = activityRef != null ? activityRef.get() : MainActivity.activeActivity;
        if (act != null) {
            act.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    act.restartCoreForAccountSwitch();
                }
            });
        }
    }

    private boolean matchesNativeBridgeToken(String candidate) {
        if (candidate == null) {
            return false;
        }
        try {
            byte[] expected = blobBridgeToken.getBytes(Charset.forName("UTF-8"));
            byte[] actual = candidate.getBytes(Charset.forName("UTF-8"));
            return MessageDigest.isEqual(expected, actual);
        } catch (Exception ignored) {
            return false;
        }
    }

    private static String createBlobBridgeToken() {
        byte[] random = new byte[32];
        new SecureRandom().nextBytes(random);
        char[] hex = "0123456789abcdef".toCharArray();
        char[] encoded = new char[random.length * 2];
        for (int i = 0; i < random.length; i++) {
            int value = random[i] & 0xff;
            encoded[i * 2] = hex[value >>> 4];
            encoded[i * 2 + 1] = hex[value & 0x0f];
        }
        return new String(encoded);
    }
}

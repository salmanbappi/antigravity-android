package com.agy.ui;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.widget.FrameLayout;

import java.util.ArrayList;
import java.util.List;

import com.agy.bridge.AndroidBridge;
import com.agy.core.CoreRuntimeState;
import com.agy.core.CoreServiceLauncher;
import com.agy.oauth.OAuthManager;
import com.agy.oauth.OAuthTokenStore;
import com.agy.runtime.RuntimeManager;
import com.agy.shell.RootBridge;
import com.agy.shell.ShizukuBridge;
import com.agy.theme.ThemeManager;
import com.agy.ui.lifecycle.AppLifecycle;
import com.agy.ui.lifecycle.BackNavigator;
import com.agy.ui.lifecycle.ThemeRefresher;
import com.agy.ui.splash.SplashController;
import com.agy.ui.webview.AgyWebChromeClient;
import com.agy.ui.webview.DesktopModePrefs;
import com.agy.ui.webview.WebViewHost;
import com.agy.util.SensitiveDataRedactor;
import com.agy.util.ViewParams;

/**
 * Activity host: builds the WebView, starts CoreServerService, shows the
 * three-dot splash until the core UI has rendered, and wires theming/OAuth.
 * All logic lives in the helper classes; this only wires them and polls.
 */
public class MainActivity extends Activity
        implements WebViewHost.Listener, AgyWebChromeClient.FileChooserCallback {

    private static final String TAG = "MainActivity";
    private static final int REQUEST_STORAGE = 100;
    private static final int REQUEST_FILE_CHOOSER = 1002;
    private static final int REQUEST_MEDIA_PERMISSIONS = 1003;
    private static final int REQUEST_APP_PERMISSIONS = 1004;
    private static final String PERMISSION_POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS";
    private static final long SPLASH_TIMEOUT_MS = 60000;
    private static final long POLL_STARTUP_INTERVAL_MS = 50;
    private static final long NETWORK_NOTIFY_DEBOUNCE_MS = 800;
    private static final long HOST_RESUME_FALLBACK_DELAY_MS = 180;

    public static volatile MainActivity activeActivity;
    private static volatile boolean sInForeground = false;

    public static boolean isInForeground() {
        return sInForeground;
    }

    private ValueCallback<Uri[]> filePathCallback;
    private android.webkit.PermissionRequest pendingPermissionRequest;

    private ThemeManager themeManager;
    private OAuthManager oauthManager;
    private RuntimeManager runtimeManager;
    private ShizukuBridge shizukuBridge;
    private RootBridge rootBridge;
    private AndroidBridge androidBridge;
    private WebViewHost webViewHost;
    private SplashController splash;
    private FrameLayout rootLayout;

    private boolean appLoaded = false;
    private boolean activityResumed = false;
    private int loadedGeneration = -1;
    private long splashDeadline;
    private long backgroundedAtMs = 0L;
    private boolean wasStopped = false;
    private boolean pendingHostResume = false;
    private long pendingResumeBackgroundMs = 0L;
    private boolean pendingResumeWasStopped = false;
    private String pendingNotificationConversationId = null;
    private boolean notificationPermissionPrompted = false;
    private long lastSyncedTokenMtime = -1L;
    private String lastAppliedTheme = null;
    private boolean destroying = false;

    private final Handler handler = new Handler(Looper.getMainLooper());

    private final Runnable dispatchPendingHostResume = new Runnable() {
        @Override
        public void run() {
            flushPendingHostResume();
        }
    };

    private void flushPendingHostResume() {
        if (!pendingHostResume) {
            return;
        }
        pendingHostResume = false;
        backgroundedAtMs = 0L;
        wasStopped = false;
        handler.removeCallbacks(dispatchPendingHostResume);
        if (!activityResumed || !appLoaded || webViewHost == null) {
            return;
        }
        WebView wv = webViewHost.getWebView();
        if (wv == null) {
            return;
        }
        AppLifecycle.notifyHostResume(wv, pendingResumeBackgroundMs, pendingResumeWasStopped);
    }

    private final Runnable splashWatchdog = new Runnable() {
        @Override
        public void run() {
            if (!destroying && appLoaded && splash != null && !splash.isFatalShown()) {
                Log.w(TAG, "watchdog: auto-dismissing splash after timeout");
                dismissSplash();
            }
        }
    };

    private final Runnable coreStateCallback = new Runnable() {
        @Override
        public void run() {
            if (destroying) {
                return;
            }
            handler.post(new Runnable() {
                @Override
                public void run() {
                    if (!destroying && activityResumed) {
                        watchCore();
                    }
                }
            });
        }
    };

    private final Runnable notifyWebViewNetworkOnline = new Runnable() {
        @Override
        public void run() {
            if (!appLoaded || webViewHost == null) {
                return;
            }
            WebView wv = webViewHost.getWebView();
            if (wv == null) {
                return;
            }
            try {
                wv.evaluateJavascript(
                        "(function(){ try { "
                                + "window.dispatchEvent(new CustomEvent('agy:network-online')); "
                                + "window.dispatchEvent(new Event('online')); "
                                + "} catch(e){} })();",
                        null);
            } catch (Exception e) {
                Log.w(TAG, "failed to dispatch network-online to webView", e);
            }
        }
    };

    /**
     * Runs during core startup/restart until the UI is loaded; once steady-state
     * is reached, updates arrive via {@link CoreRuntimeState#setStateListener}.
     */
    private final Runnable pollServer = new Runnable() {
        @Override
        public void run() {
            watchCore();
            if (activityResumed && (!appLoaded || CoreRuntimeState.restarting)) {
                handler.postDelayed(this, POLL_STARTUP_INTERVAL_MS);
            }
        }
    };

    private void watchCore() {
        String error = CoreRuntimeState.lastError;
        if (error != null) {
            if (CoreRuntimeState.restarting) {
                splash.showTransient(error);
            } else {
                splash.showFatalError(error);
            }
            return;
        }
        if (CoreRuntimeState.serverUrl != null && webViewHost != null) {
            int generation = CoreRuntimeState.readyGeneration;
            if (!appLoaded || (loadedGeneration > 0 && generation != loadedGeneration)) {
                appLoaded = true;
                loadedGeneration = generation;
                splash.clearFatal();
                if (generation > 1) {
                    splash.showLoading();
                }
                webViewHost.loadApp();
                handler.removeCallbacks(splashWatchdog);
                handler.postDelayed(splashWatchdog, 10000);
            }
            return;
        }
        if (!appLoaded && CoreRuntimeState.serverUrl == null && !splash.isFatalShown()
                && System.currentTimeMillis() > splashDeadline) {
            splash.showFatalError("core did not start within " + (SPLASH_TIMEOUT_MS / 1000) + "s");
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        activeActivity = this;
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        getWindow().setFlags(
                WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
                WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED);

        themeManager = new ThemeManager(this);
        themeManager.applyToActivity(this);


        oauthManager = new OAuthManager();
        runtimeManager = new RuntimeManager(this);
        shizukuBridge = new ShizukuBridge(this);
        rootBridge = RootBridge.getShared(this);
        rootBridge.probeAsync(false);
        androidBridge = new AndroidBridge(this, runtimeManager, shizukuBridge, rootBridge, themeManager);
        androidBridge.setActivity(this);
        webViewHost = new WebViewHost(this, themeManager, oauthManager, androidBridge, this);
        webViewHost.setListener(this);

        rootLayout = new FrameLayout(this);
        rootLayout.setBackgroundColor(themeManager.getBackgroundColor());
        setContentView(rootLayout);

        rootLayout.addView(webViewHost.getWebView(), ViewParams.full());

        splash = new SplashController(this, themeManager, rootLayout);
        splash.setRetryListener(this::retryCore);
        splash.loadInitial();

        splash.installExitAnimation(this);

        splashDeadline = System.currentTimeMillis() + SPLASH_TIMEOUT_MS;
        CoreRuntimeState.setStateListener(coreStateCallback);
        com.agy.ui.download.FileDownloader.pruneStalePendingBlobsAsync(this);
        com.agy.gateway.handlers.NotificationHandler.ensureChannels(this);
        captureNotificationIntent(getIntent());
        requestAppPermissions();

        startCoreService();
    }

    private void startCoreService() {
        try {
            CoreServiceLauncher.start(this);
        } catch (Exception e) {
            showFatalError("cannot start core service: "
                    + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
        }
    }

    /** Keep the splash visible and replace it with a readable failure message. */
    public void showFatalError(String message) {
        splash.showFatalError(message);
    }

    /** Retry re-runs install + start: stop the service, then start it again. */
    private void retryCore() {
        splash.clearFatal();
        appLoaded = false;
        loadedGeneration = -1;
        splashDeadline = System.currentTimeMillis() + SPLASH_TIMEOUT_MS;
        splash.showLoading();
        CoreServiceLauncher.stop(this);
        try {
            java.io.File marker = new java.io.File(runtimeManager.getRuntimeDir(), com.agy.runtime.RuntimePaths.RUNTIME_MARKER);
            if (marker.exists()) {
                marker.delete();
            }
        } catch (Exception ignored) {
        }
        handler.postDelayed(this::startCoreService, 400);
    }

    /** Restarts CoreServerService without forcing runtime reinstallation (fallback for account switch). */
    public void restartCoreForAccountSwitch() {
        splash.clearFatal();
        appLoaded = false;
        loadedGeneration = -1;
        splashDeadline = System.currentTimeMillis() + SPLASH_TIMEOUT_MS;
        splash.showLoading();
        CoreServiceLauncher.stop(this);
        handler.postDelayed(this::startCoreService, 350);
    }

    /**
     * Page load finished, but the Web UI has NOT necessarily painted yet (the
     * app bundle is large), so the splash is NOT dismissed here. Dismissal is
     * driven by web/patches/startup_ready.js -> AndroidBridge.onUiReady().
     */
    @Override
    public void onPageFinished(String url) {
        Log.i(TAG, "onPageFinished " + SensitiveDataRedactor.safeUrl(url));
    }

    @Override
    public void onRenderProcessGone(boolean didCrash) {
        handler.post(new Runnable() {
            @Override
            public void run() {
                if (destroying || isFinishing()
                        || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1 && isDestroyed())) {
                    return;
                }
                Log.w(TAG, "Recreating WebView after renderer termination (didCrash=" + didCrash + ")");
                pendingHostResume = false;
                backgroundedAtMs = 0L;
                wasStopped = false;
                handler.removeCallbacks(dispatchPendingHostResume);
                handler.removeCallbacks(notifyWebViewNetworkOnline);
                handler.removeCallbacks(splashWatchdog);
                if (webViewHost != null) {
                    WebView old = webViewHost.getWebView();
                    if (old != null) {
                        if (rootLayout != null) {
                            rootLayout.removeView(old);
                        }
                        destroyWebViewInstance(old);
                    }
                }
                webViewHost = new WebViewHost(MainActivity.this, themeManager, oauthManager, androidBridge, MainActivity.this);
                webViewHost.setListener(MainActivity.this);
                if (rootLayout != null) {
                    rootLayout.addView(webViewHost.getWebView(), 0, ViewParams.full());
                }
                appLoaded = false;
                loadedGeneration = -1;
                lastAppliedTheme = null;
                if (splash != null) {
                    splash.showLoading();
                }
                watchCore();
            }
        });
    }

    private static void destroyWebViewInstance(WebView wv) {
        if (wv == null) {
            return;
        }
        try {
            wv.stopLoading();
            wv.setWebChromeClient(null);
            wv.setWebViewClient(null);
            wv.setDownloadListener(null);
            wv.destroy();
        } catch (Exception e) {
            Log.w(TAG, "error destroying webView", e);
        }
    }

    /** Idempotent; called by AndroidBridge.onUiReady() on the main thread. */
    public void dismissSplash() {
        Log.i(TAG, "dismissSplash: fading out splashView (280ms)");
        splash.dismiss();
        flushPendingNotificationConversation();
        UpdateChecker.checkOnLaunch(this);
    }

    public boolean isDesktopMode() {
        return webViewHost != null ? webViewHost.isDesktopMode() : DesktopModePrefs.isDesktopMode(this);
    }

    public void setDesktopMode(boolean enabled) {
        if (webViewHost != null) {
            webViewHost.setDesktopMode(enabled);
        } else {
            DesktopModePrefs.setDesktopMode(this, enabled);
        }
    }

    public WebView getWebView() {
        return webViewHost != null ? webViewHost.getWebView() : null;
    }

    /** Called from NetworkMonitorHolder when connectivity recovers from offline. */
    public void notifyNetworkRecovered() {
        handler.removeCallbacks(notifyWebViewNetworkOnline);
        handler.postDelayed(notifyWebViewNetworkOnline, NETWORK_NOTIFY_DEBOUNCE_MS);
    }

    @Override
    protected void onDestroy() {
        destroying = true;
        activityResumed = false;
        sInForeground = false;
        pendingHostResume = false;
        CoreRuntimeState.setStateListener(null);
        if (activeActivity == this) {
            activeActivity = null;
        }
        handler.removeCallbacks(dispatchPendingHostResume);
        handler.removeCallbacks(notifyWebViewNetworkOnline);
        handler.removeCallbacks(splashWatchdog);
        if (splash != null) {
            splash.destroy();
        }
        com.agy.ui.download.FileDownloader.clearPendingTask();
        AppLifecycle.destroy(handler);
        if (androidBridge != null) {
            androidBridge.setActivity(null);
        }
        if (rootLayout != null) {
            rootLayout.removeAllViews();
        }
        if (webViewHost != null) {
            destroyWebViewInstance(webViewHost.getWebView());
        }
        if (pendingPermissionRequest != null) {
            try {
                pendingPermissionRequest.deny();
            } catch (Throwable ignored) {}
            pendingPermissionRequest = null;
        }
        super.onDestroy();
    }

    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        AppLifecycle.trimMemory(level, handler, webViewHost);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        captureNotificationIntent(intent);
        if (oauthManager != null) {
            oauthManager.handleDeepLink(this, intent, null);
        }
    }

    private void captureNotificationIntent(Intent intent) {
        if (intent == null) {
            return;
        }
        String convId = intent.getStringExtra(
                com.agy.gateway.handlers.NotificationHandler.EXTRA_CONVERSATION_ID);
        if (convId != null && !convId.trim().isEmpty()) {
            pendingNotificationConversationId = convId.trim();
            intent.removeExtra(com.agy.gateway.handlers.NotificationHandler.EXTRA_CONVERSATION_ID);
            flushPendingNotificationConversation();
        }
    }

    private void flushPendingNotificationConversation() {
        if (pendingNotificationConversationId == null || !appLoaded || webViewHost == null) {
            return;
        }
        final WebView wv = webViewHost.getWebView();
        if (wv == null) {
            return;
        }
        final String convId = pendingNotificationConversationId;
        pendingNotificationConversationId = null;
        wv.post(new Runnable() {
            @Override
            public void run() {
                try {
                    String js = "(function(id){ try { "
                            + "if (typeof window.__agOpenNotificationConversation === 'function') { "
                            + "window.__agOpenNotificationConversation(id); "
                            + "} else { "
                            + "window.__AG_PENDING_NOTIFICATION_CONV_ID__ = id; "
                            + "} } catch(e){} })(" + org.json.JSONObject.quote(convId) + ");";
                    wv.evaluateJavascript(js, null);
                } catch (Exception e) {
                    Log.w(TAG, "failed to dispatch notification conversationId", e);
                }
            }
        });
    }

    private void notifyWebViewForegroundState(boolean inForeground) {
        if (webViewHost == null) {
            return;
        }
        final WebView wv = webViewHost.getWebView();
        if (wv == null) {
            return;
        }
        try {
            wv.evaluateJavascript(
                    "(function(){ try { window.__AG_HOST_IN_FOREGROUND__="
                            + (inForeground ? "true" : "false")
                            + "; } catch(e){} })();",
                    null);
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        refreshTheme();
    }

    @Override
    protected void onPause() {
        activityResumed = false;
        sInForeground = false;
        pendingHostResume = false;
        handler.removeCallbacks(pollServer);
        handler.removeCallbacks(dispatchPendingHostResume);
        if (appLoaded && backgroundedAtMs == 0L) {
            backgroundedAtMs = SystemClock.elapsedRealtime();
        }
        notifyWebViewForegroundState(false);
        if (webViewHost != null) {
            AppLifecycle.pause(webViewHost.getWebView());
        }
        super.onPause();
    }

    @Override
    protected void onStop() {
        sInForeground = false;
        notifyWebViewForegroundState(false);
        if (appLoaded) {
            wasStopped = true;
            if (backgroundedAtMs == 0L) {
                backgroundedAtMs = SystemClock.elapsedRealtime();
            }
        }
        super.onStop();
    }

    @Override
    protected void onResume() {
        super.onResume();
        activityResumed = true;
        sInForeground = true;
        activeActivity = this;
        notifyWebViewForegroundState(true);
        if (webViewHost != null) {
            AppLifecycle.resume(webViewHost.getWebView());
        }
        if (appLoaded && backgroundedAtMs > 0L) {
            long elapsedMs = Math.max(0L, SystemClock.elapsedRealtime() - backgroundedAtMs);
            boolean stopped = wasStopped;
            backgroundedAtMs = 0L;
            wasStopped = false;
            pendingResumeBackgroundMs = elapsedMs;
            pendingResumeWasStopped = stopped;
            pendingHostResume = true;
            handler.removeCallbacks(dispatchPendingHostResume);
            handler.postDelayed(dispatchPendingHostResume, HOST_RESUME_FALLBACK_DELAY_MS);
        }
        flushPendingNotificationConversation();
        maybeRequestPostNotifications();
        refreshTheme();
        if (OAuthTokenStore.hasToken(this)) {
            java.io.File tokenFile = OAuthTokenStore.tokenFile(this);
            final long tokenMtime = tokenFile != null ? tokenFile.lastModified() : -1L;
            if (tokenMtime > 0 && tokenMtime != lastSyncedTokenMtime) {
                lastSyncedTokenMtime = tokenMtime;
                final android.content.Context appCtx = getApplicationContext();
                Thread t = new Thread(new Runnable() {
                    @Override
                    public void run() {
                        com.agy.oauth.AccountVaultStore.syncCurrentAccount(appCtx, null);
                    }
                }, "AgyVaultSync");
                t.setDaemon(true);
                t.start();
            }
        }
        handler.removeCallbacks(pollServer);
        handler.post(pollServer);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && activityResumed && pendingHostResume) {
            handler.removeCallbacks(dispatchPendingHostResume);
            handler.post(dispatchPendingHostResume);
        }
    }

    private void refreshTheme() {
        String resolved = themeManager != null ? themeManager.getTheme() : "light";
        if (resolved.equals(lastAppliedTheme)) {
            return;
        }
        lastAppliedTheme = resolved;
        ThemeRefresher.refresh(this, themeManager, rootLayout, splash, webViewHost);
        if (webViewHost != null && webViewHost.getWebView() != null) {
            webViewHost.getWebView().evaluateJavascript(
                    "window.__AG_RESOLVED_THEME__='" + resolved + "'; window.__agOnSystemThemeChanged && window.__agOnSystemThemeChanged();", null);
        }
    }

    @Override
    public void onBackPressed() {
        WebView wv = webViewHost != null ? webViewHost.getWebView() : null;
        BackNavigator.handle(this, wv, () -> MainActivity.super.onBackPressed());
    }

    private void requestAppPermissions() {
        requestStoragePermissions();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            List<String> needed = new ArrayList<>();
            if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                    != PackageManager.PERMISSION_GRANTED) {
                needed.add(android.Manifest.permission.RECORD_AUDIO);
            }
            if (Build.VERSION.SDK_INT >= 33
                    && checkSelfPermission(PERMISSION_POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                needed.add(PERMISSION_POST_NOTIFICATIONS);
                notificationPermissionPrompted = true;
            }
            if (!needed.isEmpty()) {
                requestPermissions(needed.toArray(new String[0]), REQUEST_APP_PERMISSIONS);
            }
        }
    }

    private void maybeRequestPostNotifications() {
        if (notificationPermissionPrompted || Build.VERSION.SDK_INT < 33) {
            return;
        }
        if (checkSelfPermission(PERMISSION_POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notificationPermissionPrompted = true;
            requestPermissions(new String[]{PERMISSION_POST_NOTIFICATIONS}, REQUEST_APP_PERMISSIONS);
        }
    }

    private void requestStoragePermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                if (!android.os.Environment.isExternalStorageManager()) {
                    android.content.SharedPreferences prefs = getSharedPreferences("agy_prefs", MODE_PRIVATE);
                    if (prefs.getBoolean("storage_prompted", false)) {
                        return;
                    }
                    prefs.edit().putBoolean("storage_prompted", true).apply();
                    Intent intent = new Intent(
                            android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
                    intent.setData(Uri.parse("package:" + getPackageName()));
                    startActivity(intent);
                }
            } catch (Exception e) {
                try {
                    startActivity(new Intent(
                            android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
                } catch (Exception ignored) {
                }
            }
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (checkSelfPermission(android.Manifest.permission.READ_EXTERNAL_STORAGE)
                    != PackageManager.PERMISSION_GRANTED
                    || checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{
                        android.Manifest.permission.READ_EXTERNAL_STORAGE,
                        android.Manifest.permission.WRITE_EXTERNAL_STORAGE
                }, REQUEST_STORAGE);
            }
        }
    }

    @Override
    public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> callback,
                                      WebChromeClient.FileChooserParams fileChooserParams) {
        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(null);
            filePathCallback = null;
        }
        this.filePathCallback = callback;

        Intent chooserIntent = null;

        // 1. Try standard intent built by Chromium WebChromeClient
        if (fileChooserParams != null) {
            try {
                Intent defaultIntent = fileChooserParams.createIntent();
                if (defaultIntent != null) {
                    chooserIntent = Intent.createChooser(defaultIntent, "Select Media / Files");
                }
            } catch (Throwable t) {
                Log.w(TAG, "fileChooserParams.createIntent failed: " + t.getMessage());
            }
        }

        // 2. Fallback to universal ACTION_GET_CONTENT chooser (supports Gallery, Photos, Files)
        if (chooserIntent == null) {
            Intent contentIntent = new Intent(Intent.ACTION_GET_CONTENT);
            contentIntent.addCategory(Intent.CATEGORY_OPENABLE);
            contentIntent.setType("*/*");
            if (fileChooserParams != null) {
                String[] acceptTypes = fileChooserParams.getAcceptTypes();
                if (acceptTypes != null && acceptTypes.length > 0) {
                    List<String> validMimes = new ArrayList<>();
                    for (String type : acceptTypes) {
                        if (type != null && type.contains("/")) {
                            validMimes.add(type.trim());
                        }
                    }
                    if (!validMimes.isEmpty()) {
                        contentIntent.putExtra(Intent.EXTRA_MIME_TYPES, validMimes.toArray(new String[0]));
                    }
                }
                if (fileChooserParams.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
                    contentIntent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
            }
            chooserIntent = Intent.createChooser(contentIntent, "Select Media / Files");
        }

        try {
            startActivityForResult(chooserIntent, REQUEST_FILE_CHOOSER);
            return true;
        } catch (Throwable e) {
            Log.w(TAG, "Chooser failed, fallback to plain GET_CONTENT: " + e.getMessage());
            try {
                Intent fallback = new Intent(Intent.ACTION_GET_CONTENT);
                fallback.addCategory(Intent.CATEGORY_OPENABLE);
                fallback.setType("*/*");
                if (fileChooserParams != null
                        && fileChooserParams.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
                    fallback.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
                startActivityForResult(fallback, REQUEST_FILE_CHOOSER);
                return true;
            } catch (Throwable ex) {
                Log.e(TAG, "Cannot launch file chooser: " + ex.getMessage());
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                    filePathCallback = null;
                }
                return false;
            }
        }
    }

    public static final int REQUEST_DIR_CHOOSER = 2002;

    public void launchDirectoryPicker() {
        try {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            startActivityForResult(intent, REQUEST_DIR_CHOOSER);
        } catch (Throwable t) {
            Log.w(TAG, "Cannot launch directory picker: " + t.getMessage());
            if (webViewHost != null && webViewHost.getWebView() != null) {
                webViewHost.getWebView().evaluateJavascript("window.__onDirectoryPicked && window.__onDirectoryPicked(null);", null);
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_DIR_CHOOSER) {
            String realPath = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                Uri treeUri = data.getData();
                try {
                    grantUriPermission(getPackageName(), treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (Throwable ignored) {}
                try {
                    getContentResolver().takePersistableUriPermission(treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (Throwable ignored) {}
                realPath = com.agy.util.DocumentsContractHelper.resolveTreeUriToPath(this, treeUri);
            }
            if (webViewHost != null && webViewHost.getWebView() != null) {
                final String path = realPath;
                webViewHost.getWebView().post(new Runnable() {
                    @Override
                    public void run() {
                        String jsArg = path != null ? org.json.JSONObject.quote(path) : "null";
                        webViewHost.getWebView().evaluateJavascript(
                                "window.__onDirectoryPicked && window.__onDirectoryPicked(" + jsArg + ");", null);
                    }
                });
            }
            return;
        }
        if (requestCode == REQUEST_FILE_CHOOSER) {
            if (filePathCallback != null) {
                Uri[] results = null;
                try {
                    results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
                } catch (Throwable t) {
                    Log.w(TAG, "parseResult error: " + t.getMessage());
                }
                if (results == null && resultCode == RESULT_OK && data != null) {
                    ClipData clipData = data.getClipData();
                    if (clipData != null && clipData.getItemCount() > 0) {
                        results = new Uri[clipData.getItemCount()];
                        for (int i = 0; i < clipData.getItemCount(); i++) {
                            results[i] = clipData.getItemAt(i).getUri();
                        }
                    } else if (data.getData() != null) {
                        results = new Uri[]{data.getData()};
                    } else if (data.getDataString() != null) {
                        results = new Uri[]{Uri.parse(data.getDataString())};
                    }
                }
                if (results != null) {
                    for (Uri uri : results) {
                        if (uri != null) {
                            try {
                                grantUriPermission(getPackageName(), uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            } catch (Throwable ignored) {}
                            try {
                                getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            } catch (Throwable ignored) {}
                        }
                    }
                }
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            }
        }
    }

    public void requestMediaPermissions(android.webkit.PermissionRequest request, List<String> permissions) {
        if (this.pendingPermissionRequest != null && this.pendingPermissionRequest != request) {
            try {
                this.pendingPermissionRequest.deny();
            } catch (Throwable ignored) {}
        }
        this.pendingPermissionRequest = request;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && permissions != null && !permissions.isEmpty()) {
            requestPermissions(permissions.toArray(new String[0]), REQUEST_MEDIA_PERMISSIONS);
        } else {
            if (request != null) {
                try {
                    request.grant(request.getResources());
                } catch (Throwable t) {
                    Log.w(TAG, "Failed granting media permissions: " + t.getMessage());
                }
            }
            this.pendingPermissionRequest = null;
        }
    }

    public void onMediaPermissionCanceled(android.webkit.PermissionRequest request) {
        if (this.pendingPermissionRequest != null && this.pendingPermissionRequest == request) {
            this.pendingPermissionRequest = null;
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_MEDIA_PERMISSIONS) {
            if (pendingPermissionRequest != null) {
                boolean allGranted = true;
                if (grantResults != null && grantResults.length > 0) {
                    for (int res : grantResults) {
                        if (res != PackageManager.PERMISSION_GRANTED) {
                            allGranted = false;
                            break;
                        }
                    }
                } else {
                    allGranted = false;
                }
                if (allGranted) {
                    try {
                        pendingPermissionRequest.grant(pendingPermissionRequest.getResources());
                    } catch (Throwable t) {
                        Log.w(TAG, "Failed granting media permissions: " + t.getMessage());
                    }
                } else {
                    try {
                        pendingPermissionRequest.deny();
                    } catch (Throwable t) {
                        Log.w(TAG, "Failed denying media permissions: " + t.getMessage());
                    }
                }
                pendingPermissionRequest = null;
            }
            return;
        }
        if (requestCode == com.agy.ui.download.FileDownloader.REQUEST_STORAGE_DOWNLOAD) {
            WebView wv = (webViewHost != null) ? webViewHost.getWebView() : null;
            com.agy.ui.download.FileDownloader.onPermissionResult(this, wv, requestCode, grantResults);
        }
    }
}

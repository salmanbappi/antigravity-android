package com.agy.ui.webview;

import android.util.Log;
import android.webkit.WebView;

/** WebView resume/timer/memory lifecycle, kept out of the activity. */
public final class WebViewLifecycle {

    private static final String TAG = "WebViewHost";

    private WebViewLifecycle() {
    }

    /** Resume the WebView rendering/timers when the host activity returns to the foreground. */
    public static void resume(WebView webView) {
        if (webView == null) {
            return;
        }
        try {
            webView.onResume();
            webView.resumeTimers();
        } catch (Exception e) {
            Log.w(TAG, "failed to resume webView", e);
        }
    }

    /**
     * Dispatches a single host-resume event to the web layer once the window is
     * visible/focused again. The web bridge (fetch-rewrite.js) coordinates any
     * stream reset and synthetic focus/online/visibility notifications.
     */
    public static void notifyHostResume(WebView webView, long backgroundMs, boolean wasStopped) {
        if (webView == null) {
            return;
        }
        long elapsed = Math.max(0L, backgroundMs);
        try {
            webView.evaluateJavascript(
                    "(function(){ try { "
                            + "window.dispatchEvent(new CustomEvent('agy:host-resume', { detail: { "
                            + "backgroundMs: " + elapsed + ", "
                            + "wasStopped: " + (wasStopped ? "true" : "false")
                            + " } })); "
                            + "} catch(e){} })();",
                    null);
        } catch (Exception e) {
            Log.w(TAG, "failed to dispatch host-resume to webView", e);
        }
    }

    /**
     * Intentionally a no-op while CoreServerService keeps the backend running:
     * calling webView.onPause() or pauseTimers() suspends/throttles Chromium's
     * WebContents and stalls active ConnectRPC/gRPC-web streaming readers
     * (StreamAgentStateUpdates), leaving the UI stuck on pre-background state.
     */
    public static void pause(WebView webView) {
        // Intentionally left unpaused so background agent streams keep draining.
    }

    public static void freeMemory(WebView webView) {
        if (webView == null) {
            return;
        }
        try {
            webView.freeMemory();
        } catch (Exception e) {
            Log.w(TAG, "freeMemory failed", e);
        }
    }
}

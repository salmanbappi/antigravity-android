package com.agy.ui.lifecycle;

import android.content.ComponentCallbacks2;
import android.os.Handler;
import android.os.SystemClock;
import android.webkit.WebView;

import com.agy.ui.webview.WebViewHost;
import com.agy.ui.webview.WebViewLifecycle;

/** Activity lifecycle glue: WebView resume, trim-memory and handler teardown. */
public final class AppLifecycle {

    private static final long TRIM_COOLDOWN_MS = 5000L;
    private static long lastTrimMs = 0L;

    private AppLifecycle() {
    }

    public static void resume(WebView webView) {
        WebViewLifecycle.resume(webView);
    }

    public static void notifyHostResume(WebView webView, long backgroundMs, boolean wasStopped) {
        WebViewLifecycle.notifyHostResume(webView, backgroundMs, wasStopped);
    }

    public static void pause(WebView webView) {
        WebViewLifecycle.pause(webView);
    }

    public static void trimMemory(int level, Handler handler, final WebViewHost host) {
        if (host == null) {
            return;
        }
        boolean shouldFree = level >= ComponentCallbacks2.TRIM_MEMORY_BACKGROUND
                || level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW
                || level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL;
        if (!shouldFree) {
            return;
        }
        long now = SystemClock.uptimeMillis();
        if (now - lastTrimMs < TRIM_COOLDOWN_MS) {
            return;
        }
        lastTrimMs = now;
        handler.post(new Runnable() {
            @Override
            public void run() {
                host.freeMemory();
            }
        });
    }

    public static void destroy(Handler handler) {
        handler.removeCallbacksAndMessages(null);
    }
}

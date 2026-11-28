package com.agy.ui.lifecycle;

import android.app.Activity;
import android.os.Build;
import android.webkit.ValueCallback;
import android.webkit.WebView;

/**
 * Back handling: let the web UI step back inside open overlays, dismiss
 * non-URL-backed dialogs/sheets, or step back one SPA router entry via
 * {@code window.history.back()} before falling back to WebView history or
 * finishing the activity.
 */
public final class BackNavigator {

    private static final String JS_HANDLE_BACK =
            "(function(){if(typeof window.__agHandleBack!=='function')return '0';"
                    + "var r=window.__agHandleBack();"
                    + "return r==='exit'?'2':(r?'1':'0');})()";

    private BackNavigator() {
    }

    private static boolean isActivityAlive(Activity activity) {
        if (activity == null) {
            return true;
        }
        if (activity.isFinishing()) {
            return false;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1 && activity.isDestroyed()) {
            return false;
        }
        return true;
    }

    /**
     * Dispatches Back to {@code window.__agHandleBack()}:
     * <ul>
     *   <li>{@code "1"}: consumed by JS (overlay back/close/escape or SPA history step-back).</li>
     *   <li>{@code "2"}: clean Home root — invoke {@code fallback} directly (skipping {@code webView.goBack()}).</li>
     *   <li>{@code "0"} (or error): walk WebView history if possible, else invoke {@code fallback}.</li>
     * </ul>
     */
    public static void handle(final Activity activity, final WebView webView, final Runnable fallback) {
        if (!isActivityAlive(activity)) {
            return;
        }
        if (webView == null) {
            if (fallback != null) {
                fallback.run();
            }
            return;
        }
        try {
            webView.evaluateJavascript(JS_HANDLE_BACK, new ValueCallback<String>() {
                @Override
                public void onReceiveValue(String value) {
                    if ("\"1\"".equals(value)) {
                        return;
                    }
                    if (!isActivityAlive(activity)) {
                        return;
                    }
                    if ("\"2\"".equals(value)) {
                        if (fallback != null) {
                            fallback.run();
                        }
                        return;
                    }
                    if (webView.canGoBack()) {
                        webView.goBack();
                    } else if (fallback != null) {
                        fallback.run();
                    }
                }
            });
        } catch (Throwable ignored) {
            if (!isActivityAlive(activity)) {
                return;
            }
            if (webView.canGoBack()) {
                webView.goBack();
            } else if (fallback != null) {
                fallback.run();
            }
        }
    }
}

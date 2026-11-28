package com.agy.ui.webview;

import android.content.Context;
import android.os.Build;
import android.util.Log;
import android.view.MotionEvent;
import android.view.View;
import android.webkit.WebView;

import com.agy.BuildConfig;
import com.agy.bridge.AndroidBridge;
import com.agy.theme.ThemeManager;

/** Creates and hardware-configures the host WebView. */
public final class WebViewFactory {

    private static final String TAG = "WebViewHost";

    private WebViewFactory() {
    }

    public static WebView create(Context context, AndroidBridge bridge, ThemeManager theme) {
        WebView view = new AgyWebView(context);
        view.setBackgroundColor(theme.getBackgroundColor());
        view.setFocusable(true);
        view.setFocusableInTouchMode(true);
        view.requestFocus(View.FOCUS_DOWN);
        // Do NOT set LAYER_TYPE_HARDWARE on WebView: Chromium internally handles
        // its own hardware-accelerated compositor. Setting an Android View hardware
        // layer forces Android RenderNode to allocate an extra full-screen FBO texture
        // and perform an unnecessary extra blit at 120Hz, causing severe GPU stalls.
        view.setLayerType(View.LAYER_TYPE_NONE, null);
        // Delegate overscroll to web CSS (contain) and eliminate double scrollbar draws on UI thread
        view.setOverScrollMode(View.OVER_SCROLL_NEVER);
        view.setVerticalScrollBarEnabled(false);
        view.setHorizontalScrollBarEnabled(false);
        view.addJavascriptInterface(bridge, "Android");
        // Android WebView needs an explicit focus grant for the soft keyboard to show.
        view.setOnTouchListener(new View.OnTouchListener() {
            @Override
            public boolean onTouch(View v, MotionEvent event) {
                if (event.getAction() == MotionEvent.ACTION_DOWN) {
                    ((WebView) v).requestFocus(View.FOCUS_DOWN);
                }
                return false;
            }
        });

        WebSettingsFactory.configure(view);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                // Keep the WebView renderer at IMPORTANT priority even when the
                // activity is backgrounded, matching CoreServerService's foreground
                // lifetime so Android/OEMs do not freeze or kill active streams.
                view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
            } catch (Throwable t) {
                Log.w(TAG, "setRendererPriorityPolicy failed", t);
            }
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT && BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        return view;
    }
}

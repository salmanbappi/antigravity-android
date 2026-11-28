package com.agy.gateway.handlers;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import com.agy.ui.MainActivity;

import org.json.JSONObject;

/**
 * Handles native Android notifications (title, message, progress, channels, cancel).
 */
public final class NotificationHandler {

    private static final String TAG = "NotificationHandler";
    public static final String CHANNEL_TASKS = "agy_tasks";
    public static final String CHANNEL_ALERTS = "agy_alerts";
    public static final String EXTRA_CONVERSATION_ID = "com.agy.extra.CONVERSATION_ID";
    private static final String ACTION_OPEN_CONVERSATION = "com.agy.action.OPEN_CONVERSATION";
    private static final int AGENT_NOTIFY_ID = 45170;

    private final Context context;
    private final NotificationManager manager;

    public NotificationHandler(Context context) {
        this.context = context.getApplicationContext();
        this.manager = (NotificationManager) this.context.getSystemService(Context.NOTIFICATION_SERVICE);
        initChannels(this.manager);
    }

    /** Ensures notification channels are created early (e.g. from foreground MainActivity). */
    public static void ensureChannels(Context context) {
        if (context == null) {
            return;
        }
        try {
            NotificationManager nm = (NotificationManager) context.getApplicationContext()
                    .getSystemService(Context.NOTIFICATION_SERVICE);
            initChannels(nm);
        } catch (Exception e) {
            Log.w(TAG, "ensureChannels error: " + e.getMessage());
        }
    }

    private static void initChannels(NotificationManager manager) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null) {
            NotificationChannel tasks = new NotificationChannel(
                    CHANNEL_TASKS, "Antigravity Tasks", NotificationManager.IMPORTANCE_DEFAULT);
            tasks.setDescription("Notifications for ongoing AI agent and environment tasks");
            manager.createNotificationChannel(tasks);

            NotificationChannel alerts = new NotificationChannel(
                    CHANNEL_ALERTS, "Antigravity Alerts", NotificationManager.IMPORTANCE_HIGH);
            alerts.setDescription("High-priority alerts for agent replies, completions, and approvals");
            alerts.enableVibration(true);
            alerts.enableLights(true);
            alerts.setShowBadge(true);
            alerts.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            try {
                Uri soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
                if (soundUri != null) {
                    AudioAttributes attrs = new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build();
                    alerts.setSound(soundUri, attrs);
                }
            } catch (Exception ignored) {
            }
            manager.createNotificationChannel(alerts);
        }
    }

    private static PendingIntent createLaunchPendingIntent(Context ctx, int requestCode) {
        return createLaunchPendingIntent(ctx, requestCode, null);
    }

    private static PendingIntent createLaunchPendingIntent(Context ctx, int requestCode, String conversationId) {
        Intent intent = new Intent(ctx, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_NEW_TASK);
        if (conversationId != null && !conversationId.trim().isEmpty()) {
            intent.setAction(ACTION_OPEN_CONVERSATION);
            intent.putExtra(EXTRA_CONVERSATION_ID, conversationId.trim());
        }
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getActivity(ctx, requestCode, intent, flags);
    }

    /** Opens Android's per-app notification settings screen. */
    public static void openNotificationSettings(Context context) {
        if (context == null) {
            return;
        }
        Context appCtx = context.getApplicationContext();
        try {
            Intent intent;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                intent.putExtra(Settings.EXTRA_APP_PACKAGE, appCtx.getPackageName());
            } else {
                intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                intent.setData(Uri.parse("package:" + appCtx.getPackageName()));
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            appCtx.startActivity(intent);
        } catch (Exception e) {
            Log.w(TAG, "openNotificationSettings error: " + e.getMessage());
        }
    }

    /** Posts a high-priority clickable notification when the agent completes or needs input in background. */
    public static void postAgentAlert(Context context, String tag, String title, String message) {
        postAgentAlert(context, tag, title, message, null, false);
    }

    /**
     * Posts a high-priority clickable notification with optional conversation deep-link
     * when the agent completes a task, replies, or needs approval while backgrounded.
     */
    public static void postAgentAlert(Context context, String tag, String title, String message,
                                      String conversationId, boolean silent) {
        if (context == null) {
            return;
        }
        try {
            Context appCtx = context.getApplicationContext();
            NotificationManager nm = (NotificationManager) appCtx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) {
                return;
            }
            initChannels(nm);
            int icon = appCtx.getResources().getIdentifier("ic_notification", "drawable", appCtx.getPackageName());
            if (icon == 0) {
                icon = android.R.drawable.ic_dialog_info;
            }
            String safeConv = (conversationId != null && !conversationId.trim().isEmpty())
                    ? conversationId.trim() : null;
            String safeTag = (safeConv != null)
                    ? ("agy_agent_" + safeConv)
                    : ((tag != null && !tag.trim().isEmpty()) ? tag.trim() : "agy_agent_event");
            int notifyId = (safeConv != null)
                    ? (AGENT_NOTIFY_ID + 1 + (Math.abs(safeConv.hashCode()) % 10000))
                    : AGENT_NOTIFY_ID;
            String safeTitle = (title != null && !title.trim().isEmpty()) ? title.trim() : "Antigravity";
            String safeMsg = (message != null && !message.trim().isEmpty()) ? message.trim() : "Agent update ready";

            Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? new Notification.Builder(appCtx, CHANNEL_ALERTS)
                    : new Notification.Builder(appCtx);
            builder.setContentTitle(safeTitle)
                    .setContentText(safeMsg)
                    .setSmallIcon(icon)
                    .setAutoCancel(true)
                    .setWhen(System.currentTimeMillis())
                    .setShowWhen(true)
                    .setOnlyAlertOnce(silent)
                    .setContentIntent(createLaunchPendingIntent(appCtx, notifyId, safeConv));
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                builder.setCategory(Notification.CATEGORY_MESSAGE)
                        .setVisibility(Notification.VISIBILITY_PUBLIC);
            }
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                builder.setPriority(Notification.PRIORITY_HIGH);
                if (!silent) {
                    builder.setDefaults(Notification.DEFAULT_ALL);
                }
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN) {
                builder.setStyle(new Notification.BigTextStyle().bigText(safeMsg));
            }
            nm.notify(safeTag, notifyId, builder.build());
        } catch (Exception e) {
            Log.w(TAG, "postAgentAlert error: " + e.getMessage());
        }
    }

    public JSONObject handle(JSONObject payload) {
        JSONObject resp = new JSONObject();
        try {
            String action = payload.optString("action", "post");
            String tag = payload.optString("tag", "agy_task");
            int id = payload.optInt("id", (int) (System.currentTimeMillis() % 100000));

            if ("cancel".equalsIgnoreCase(action)) {
                if (manager != null) {
                    manager.cancel(tag, id);
                }
                resp.put("ok", true);
                resp.put("cancelled", true);
                return resp;
            }

            String title = payload.optString("title", "Antigravity");
            String message = payload.optString("message", "");
            int progress = payload.optInt("progress", -1);
            boolean ongoing = payload.optBoolean("ongoing", false);
            String channel = payload.optString("channel", CHANNEL_TASKS);

            if (manager == null) {
                resp.put("ok", false);
                resp.put("error", "NotificationManager unavailable");
                return resp;
            }

            int icon = context.getResources().getIdentifier("ic_notification", "drawable", context.getPackageName());
            if (icon == 0) {
                icon = android.R.drawable.ic_dialog_info;
            }

            Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? new Notification.Builder(context, channel)
                    : new Notification.Builder(context);

            builder.setContentTitle(title)
                    .setContentText(message)
                    .setSmallIcon(icon)
                    .setOngoing(ongoing)
                    .setAutoCancel(!ongoing)
                    .setContentIntent(createLaunchPendingIntent(context, id));

            if (progress >= 0) {
                builder.setProgress(100, Math.min(100, Math.max(0, progress)), false);
            } else if ("indeterminate".equalsIgnoreCase(payload.optString("progress_mode"))) {
                builder.setProgress(0, 0, true);
            }

            manager.notify(tag, id, builder.build());

            resp.put("ok", true);
            resp.put("tag", tag);
            resp.put("id", id);
        } catch (Exception e) {
            Log.w(TAG, "Notification error: " + e.getMessage());
            try {
                resp.put("ok", false);
                resp.put("error", e.getMessage());
            } catch (Exception ignored) {}
        }
        return resp;
    }
}

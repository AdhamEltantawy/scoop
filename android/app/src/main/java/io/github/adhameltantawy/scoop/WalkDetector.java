package io.github.adhameltantawy.scoop;

import android.Manifest;
import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.google.android.gms.location.ActivityRecognition;
import com.google.android.gms.location.ActivityTransition;
import com.google.android.gms.location.ActivityTransitionRequest;
import com.google.android.gms.location.DetectedActivity;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;

/**
 * Notices when you start walking (Android's activity recognition, no location
 * needed) and, if you keep walking for a few minutes without a walk running in
 * Scoop, posts a notification offering to start one.
 */
public final class WalkDetector {
    private static final String TAG = "ScoopWalkDetector";

    static final String PREFS = "scoop.walkReminders";
    static final String KEY_ENABLED = "enabled";
    static final String KEY_WALKING_SINCE = "walkingSince";   // wall clock ms, 0 = not walking
    static final String KEY_WALK_ACTIVE_SINCE = "walkActive"; // a walk is recording in the app, 0 = no
    static final String KEY_LAST_WALK_END = "lastWalkEnd";
    static final String KEY_LAST_NOTIFIED = "lastNotified";

    static final String ACTION_TRANSITION = "io.github.adhameltantawy.scoop.WALK_TRANSITION";
    static final String ACTION_CHECK = "io.github.adhameltantawy.scoop.WALK_CHECK";
    static final String EXTRA_START_WALK = "scoop.startWalk";

    static final String CHANNEL_ID = "walk_reminders";
    static final int NOTIFICATION_ID = 4201;

    /** Keep walking this long before we ask. Filters out short walks to the car or the kitchen. */
    static final long SUSTAINED_MS = 3 * 60 * 1000L;
    /** At most one reminder in this window. */
    static final long COOLDOWN_MS = 3 * 60 * 60 * 1000L;
    /** Don't ask right after a walk was stopped (you're probably walking home). */
    static final long AFTER_WALK_MS = 30 * 60 * 1000L;
    /** A walk flag older than this is stale (the app was killed mid-walk). */
    static final long WALK_STALE_MS = 6 * 60 * 60 * 1000L;
    /** No reminders from 22:00 to 07:00. */
    static final int QUIET_FROM_HOUR = 22;
    static final int QUIET_TO_HOUR = 7;

    private WalkDetector() {}

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean isEnabled(Context ctx) {
        return prefs(ctx).getBoolean(KEY_ENABLED, false);
    }

    static boolean hasActivityPermission(Context ctx) {
        String perm = Build.VERSION.SDK_INT >= 29
                ? Manifest.permission.ACTIVITY_RECOGNITION
                : "com.google.android.gms.permission.ACTIVITY_RECOGNITION";
        return ContextCompat.checkSelfPermission(ctx, perm) == PackageManager.PERMISSION_GRANTED;
    }

    static boolean hasNotificationPermission(Context ctx) {
        if (Build.VERSION.SDK_INT < 33) return true;
        return ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    private static int mutableFlag() {
        return Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0;
    }

    private static PendingIntent transitionIntent(Context ctx) {
        Intent i = new Intent(ctx, WalkTransitionReceiver.class).setAction(ACTION_TRANSITION);
        // Must be mutable: Play services fills in the transition result.
        return PendingIntent.getBroadcast(ctx, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | mutableFlag());
    }

    private static PendingIntent checkIntent(Context ctx) {
        Intent i = new Intent(ctx, WalkTransitionReceiver.class).setAction(ACTION_CHECK);
        return PendingIntent.getBroadcast(ctx, 1, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Start listening for walking, if reminders are on and allowed. Safe to call repeatedly. */
    static void register(Context ctx) {
        if (!isEnabled(ctx) || !hasActivityPermission(ctx)) return;
        List<ActivityTransition> transitions = new ArrayList<>();
        transitions.add(new ActivityTransition.Builder()
                .setActivityType(DetectedActivity.WALKING)
                .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_ENTER).build());
        transitions.add(new ActivityTransition.Builder()
                .setActivityType(DetectedActivity.WALKING)
                .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_EXIT).build());
        try {
            ActivityRecognition.getClient(ctx)
                    .requestActivityTransitionUpdates(new ActivityTransitionRequest(transitions), transitionIntent(ctx))
                    .addOnFailureListener(e -> Log.w(TAG, "Couldn't register for walking updates", e));
        } catch (SecurityException e) {
            Log.w(TAG, "Activity recognition not allowed", e);
        }
    }

    static void unregister(Context ctx) {
        try {
            ActivityRecognition.getClient(ctx).removeActivityTransitionUpdates(transitionIntent(ctx));
        } catch (SecurityException e) {
            Log.w(TAG, "Couldn't unregister", e);
        }
        cancelCheck(ctx);
        prefs(ctx).edit().putLong(KEY_WALKING_SINCE, 0).apply();
    }

    static void onWalkingStarted(Context ctx, long when) {
        SharedPreferences p = prefs(ctx);
        if (p.getLong(KEY_WALKING_SINCE, 0) == 0) p.edit().putLong(KEY_WALKING_SINCE, when).apply();
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        // Inexact on purpose: no exact-alarm permission needed, and a minute late is fine.
        am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + SUSTAINED_MS, checkIntent(ctx));
    }

    static void onWalkingStopped(Context ctx) {
        prefs(ctx).edit().putLong(KEY_WALKING_SINCE, 0).apply();
        cancelCheck(ctx);
    }

    private static void cancelCheck(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(checkIntent(ctx));
    }

    /** Called a few minutes after walking began: ask, if everything still says so. */
    static void maybeNotify(Context ctx) {
        SharedPreferences p = prefs(ctx);
        long now = System.currentTimeMillis();
        long since = p.getLong(KEY_WALKING_SINCE, 0);
        if (!isEnabled(ctx) || since == 0 || now - since < SUSTAINED_MS - 30_000) return;
        long active = p.getLong(KEY_WALK_ACTIVE_SINCE, 0);
        if (active != 0 && now - active < WALK_STALE_MS) return;
        if (now - p.getLong(KEY_LAST_WALK_END, 0) < AFTER_WALK_MS) return;
        if (now - p.getLong(KEY_LAST_NOTIFIED, 0) < COOLDOWN_MS) return;
        int hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY);
        if (hour >= QUIET_FROM_HOUR || hour < QUIET_TO_HOUR) return;
        if (!hasNotificationPermission(ctx)) return;
        showNotification(ctx);
        p.edit().putLong(KEY_LAST_NOTIFIED, now).apply();
    }

    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Walk reminders",
                NotificationManager.IMPORTANCE_DEFAULT);
        ch.setDescription("Offers to start a walk when your phone notices you're walking");
        nm.createNotificationChannel(ch);
    }

    static void showNotification(Context ctx) {
        ensureChannel(ctx);
        Intent open = new Intent(ctx, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(EXTRA_START_WALK, true);
        PendingIntent start = PendingIntent.getActivity(ctx, 2, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("Out for a walk?")
                .setContentText("Tap to start recording, so the hexes you pass count.")
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setContentIntent(start)
                .addAction(0, "Start walk", start)
                .setAutoCancel(true)
                // Gone again if you haven't answered while you're still out.
                .setTimeoutAfter(30 * 60 * 1000L);
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIFICATION_ID, b.build());
    }

    static void cancelNotification(Context ctx) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(NOTIFICATION_ID);
    }
}

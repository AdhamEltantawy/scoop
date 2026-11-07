package io.github.adhameltantawy.scoop;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;

/**
 * "You're passing a landmark": posted by the app (via WalkReminderPlugin)
 * when a walk running with the screen off enters a hex where another explorer
 * left a landmark. Tapping it opens the app on that landmark.
 */
final class LandmarkNotifier {
    static final String CHANNEL_ID = "landmarks";
    static final String EXTRA_LANDMARK = "scoop.landmark";
    static final int NOTIFICATION_ID = 4202;

    private LandmarkNotifier() {}

    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Landmarks",
                NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Tells you when you walk past a landmark another explorer left");
        nm.createNotificationChannel(ch);
    }

    /** Returns false when notifications aren't allowed. */
    static boolean show(Context ctx, long id, String title, String text) {
        if (!WalkDetector.hasNotificationPermission(ctx)) return false;
        ensureChannel(ctx);
        Intent open = new Intent(ctx, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(EXTRA_LANDMARK, id);
        PendingIntent tap = PendingIntent.getActivity(ctx, 3, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_RECOMMENDATION)
                .setContentIntent(tap)
                .addAction(0, "Check it", tap)
                .setAutoCancel(true)
                // You've probably walked on by then.
                .setTimeoutAfter(60 * 60 * 1000L);
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return false;
        nm.notify(NOTIFICATION_ID, b.build());
        return true;
    }

    static void cancel(Context ctx) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(NOTIFICATION_ID);
    }
}

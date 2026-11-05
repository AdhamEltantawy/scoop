package io.github.adhameltantawy.scoop;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import com.google.android.gms.location.ActivityTransition;
import com.google.android.gms.location.ActivityTransitionEvent;
import com.google.android.gms.location.ActivityTransitionResult;
import com.google.android.gms.location.DetectedActivity;

/** Receives walking start/stop events, the delayed check, and boot/update (to re-register). */
public class WalkTransitionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            WalkDetector.prefs(ctx).edit().putLong(WalkDetector.KEY_WALKING_SINCE, 0).apply();
            WalkDetector.register(ctx);
            return;
        }
        if (WalkDetector.ACTION_CHECK.equals(action)) {
            WalkDetector.maybeNotify(ctx);
            return;
        }
        if (!WalkDetector.isEnabled(ctx) || !ActivityTransitionResult.hasResult(intent)) return;
        ActivityTransitionResult result = ActivityTransitionResult.extractResult(intent);
        if (result == null) return;
        // Events come oldest first; the last one for walking wins.
        Boolean walking = null;
        for (ActivityTransitionEvent e : result.getTransitionEvents()) {
            if (e.getActivityType() != DetectedActivity.WALKING) continue;
            walking = e.getTransitionType() == ActivityTransition.ACTIVITY_TRANSITION_ENTER;
        }
        if (walking == null) return;
        if (walking) WalkDetector.onWalkingStarted(ctx, System.currentTimeMillis());
        else WalkDetector.onWalkingStopped(ctx);
    }
}

package io.github.adhameltantawy.scoop;

import android.Manifest;
import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.List;

/**
 * JS bridge for walk reminders: turn them on/off, tell the detector when a walk
 * is recording, and hand "Start walk" taps from the notification to the app.
 */
@CapacitorPlugin(
        name = "WalkReminder",
        permissions = {
                @Permission(alias = "activity", strings = { Manifest.permission.ACTIVITY_RECOGNITION }),
                @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
        })
public class WalkReminderPlugin extends Plugin {
    private boolean pendingStart = false;

    @Override
    public void load() {
        Intent i = getActivity().getIntent();
        if (i != null && i.getBooleanExtra(WalkDetector.EXTRA_START_WALK, false)) {
            pendingStart = true;
            i.removeExtra(WalkDetector.EXTRA_START_WALK);
        }
        WalkDetector.register(getContext());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent == null || !intent.getBooleanExtra(WalkDetector.EXTRA_START_WALK, false)) return;
        intent.removeExtra(WalkDetector.EXTRA_START_WALK);
        WalkDetector.cancelNotification(getContext());
        if (hasListeners("startWalk")) notifyListeners("startWalk", new JSObject());
        else pendingStart = true;
    }

    /** True once if the app was opened from the reminder's "Start walk". */
    @PluginMethod
    public void takeStartRequest(PluginCall call) {
        JSObject r = new JSObject();
        r.put("start", pendingStart);
        if (pendingStart) WalkDetector.cancelNotification(getContext());
        pendingStart = false;
        call.resolve(r);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(status());
    }

    private JSObject status() {
        JSObject r = new JSObject();
        r.put("enabled", WalkDetector.isEnabled(getContext()));
        r.put("activityAllowed", WalkDetector.hasActivityPermission(getContext()));
        r.put("notificationsAllowed", WalkDetector.hasNotificationPermission(getContext()));
        return r;
    }

    /** Ask for whatever permissions are missing, then switch reminders on if allowed. */
    @PluginMethod
    public void enable(PluginCall call) {
        List<String> missing = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 29 && getPermissionState("activity") != PermissionState.GRANTED) missing.add("activity");
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) missing.add("notifications");
        if (missing.isEmpty()) {
            finishEnable(call);
            return;
        }
        requestPermissionForAliases(missing.toArray(new String[0]), call, "permissionsDone");
    }

    @PermissionCallback
    private void permissionsDone(PluginCall call) {
        finishEnable(call);
    }

    private void finishEnable(PluginCall call) {
        boolean ok = WalkDetector.hasActivityPermission(getContext()) && WalkDetector.hasNotificationPermission(getContext());
        WalkDetector.prefs(getContext()).edit().putBoolean(WalkDetector.KEY_ENABLED, ok).apply();
        if (ok) {
            WalkDetector.ensureChannel(getContext());
            WalkDetector.register(getContext());
        }
        call.resolve(status());
    }

    @PluginMethod
    public void disable(PluginCall call) {
        WalkDetector.prefs(getContext()).edit().putBoolean(WalkDetector.KEY_ENABLED, false).apply();
        WalkDetector.unregister(getContext());
        WalkDetector.cancelNotification(getContext());
        call.resolve(status());
    }

    /** The app tells us when a walk starts and stops, so we never ask during one. */
    @PluginMethod
    public void setWalking(PluginCall call) {
        boolean active = Boolean.TRUE.equals(call.getBoolean("active", false));
        long now = System.currentTimeMillis();
        android.content.SharedPreferences p = WalkDetector.prefs(getContext());
        long was = p.getLong(WalkDetector.KEY_WALK_ACTIVE_SINCE, 0);
        android.content.SharedPreferences.Editor e = p.edit().putLong(WalkDetector.KEY_WALK_ACTIVE_SINCE, active ? now : 0);
        if (!active && was != 0) e.putLong(WalkDetector.KEY_LAST_WALK_END, now);
        e.apply();
        if (active) WalkDetector.cancelNotification(getContext());
        call.resolve();
    }
}

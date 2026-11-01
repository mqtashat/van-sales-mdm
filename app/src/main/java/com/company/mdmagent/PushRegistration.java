package com.company.mdmagent;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseUser;
import com.google.firebase.functions.FirebaseFunctions;
import com.google.firebase.messaging.FirebaseMessaging;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/** Tokens stay outside deviceStatus and are never logged. Registration failure cannot block policy sync. */
final class PushRegistration {
    private static final AtomicBoolean BUSY = new AtomicBoolean(false);
    private static final long REFRESH_MS = 24 * 60 * 60 * 1000L;
    private static final String PREFS = "push-registration";
    private PushRegistration() {}

    static void invalidate(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove("registered_at").apply();
    }

    static String status(Context context) {
        SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        FirebaseUser user = FirebaseAuth.getInstance().getCurrentUser();
        if (user == null || !user.getUid().equals(p.getString("uid", ""))) return "لم يسجّل بعد";
        return p.getString("status", "لم يسجّل بعد");
    }

    static void refresh(Context context) {
        Context app = context.getApplicationContext();
        FirebaseUser user = FirebaseAuth.getInstance().getCurrentUser();
        if (user == null || !PolicySyncService.canRunForegroundService(app)) return;
        String uid = user.getUid();
        SharedPreferences p = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        boolean visible = PolicyMessagingService.canShowUpdateNotification(app);
        long age = System.currentTimeMillis() - p.getLong("registered_at", 0);
        if (uid.equals(p.getString("uid", "")) && age >= 0 && age < REFRESH_MS
                && visible == p.getBoolean("notifications_enabled", false)) return;
        if (!BUSY.compareAndSet(false, true)) return;
        p.edit().putString("uid", uid).putString("status", "جارٍ تسجيل استقبال تحديثات السياسة…").apply();
        FirebaseMessaging.getInstance().getToken().continueWithTask(task -> {
            if (!task.isSuccessful()) throw new IllegalStateException("FCM token unavailable");
            FirebaseUser current = FirebaseAuth.getInstance().getCurrentUser();
            if (current == null || !uid.equals(current.getUid())) throw new IllegalStateException("Identity changed");
            Map<String, Object> data = new HashMap<>();
            data.put("token", task.getResult());
            data.put("notifications_enabled", visible);
            data.put("agent_version", SyncEngine.AGENT_VERSION);
            return FirebaseFunctions.getInstance("us-central1")
                    .getHttpsCallable("registerMdmPush").call(data);
        }).addOnCompleteListener(task -> {
            BUSY.set(false);
            FirebaseUser current = FirebaseAuth.getInstance().getCurrentUser();
            if (current == null || !uid.equals(current.getUid())) return;
            if (task.isSuccessful()) {
                p.edit().putString("uid", uid).putLong("registered_at", System.currentTimeMillis())
                        .putBoolean("notifications_enabled", visible)
                        .putString("status", "مسجّل لاستقبال تنبيهات FCM (ليس تأكيد تطبيق السياسة)").apply();
                Log.i(SyncEngine.TAG, "push_registration_ok");
            } else {
                p.edit().remove("registered_at").putString("status", "تعذر تسجيل FCM؛ تحقق من نشر وظائف Firebase والاتصال").apply();
                // Do not log exception messages: SDK errors can contain request details.
                Log.w(SyncEngine.TAG, "push_registration_failed");
            }
        });
    }
}

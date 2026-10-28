package com.company.mdmagent;

import android.app.admin.DevicePolicyManager;
import android.content.*;
import android.os.*;
import com.google.android.gms.tasks.Tasks;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseUser;
import com.google.firebase.firestore.*;
import java.util.*;
import java.util.concurrent.TimeUnit;

final class SyncEngine {
    // Serialize worker + foreground syncs; never let an old response overwrite a newer one.
    static synchronized String sync(Context context) throws Exception {
        FirebaseUser user = FirebaseAuth.getInstance().getCurrentUser();
        if (user == null) return "افتح التطبيق وسجّل جهاز التجربة أولًا.";
        FirebaseFirestore db = FirebaseFirestore.getInstance();
        String uid = user.getUid();
        DocumentSnapshot enrollment = Tasks.await(db.collection("enrollments").document(uid)
                .get(Source.SERVER), 25, TimeUnit.SECONDS);
        if (!enrollment.exists() || !Boolean.TRUE.equals(enrollment.getBoolean("approved")))
            return "بانتظار اعتماد الجهاز في Firebase؛ القيود الحالية لا تتغير.";

        DevicePolicyManager dpm = (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        ComponentName admin = new ComponentName(context, AdminReceiver.class);
        boolean owner = dpm.isDeviceOwnerApp(context.getPackageName());
        SharedPreferences prefs = context.getSharedPreferences("applied-policy", Context.MODE_PRIVATE);
        long applied = prefs.getLong("revision", 0);
        String error = "";
        String result;
        try {
            DocumentSnapshot snapshot = Tasks.await(db.collection("policies").document(uid)
                    .get(Source.SERVER), 25, TimeUnit.SECONDS);
            if (!snapshot.exists()) {
                result = "الجهاز معتمد؛ لم تُنشأ سياسة بعد. لا تغيير في القيود.";
            } else {
                Policy policy = Policy.parse(snapshot.getData(), applied);
                if (!owner) throw new IllegalStateException("Device Owner غير مفعّل؛ لم تطبّق السياسة.");
                AppRestrictions.apply(context, dpm, admin, policy.blockedApps, prefs);
                if (policy.blockTethering) dpm.addUserRestriction(admin, UserManager.DISALLOW_CONFIG_TETHERING);
                else dpm.clearUserRestriction(admin, UserManager.DISALLOW_CONFIG_TETHERING);
                boolean actual = dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_CONFIG_TETHERING);
                if (actual != policy.blockTethering) throw new IllegalStateException("تعذر التحقق من تطبيق القيد.");
                applied = policy.revision;
                prefs.edit().putLong("revision", applied).apply();
                result = actual ? "تم التحقق: مشاركة الإنترنت ممنوعة." : "تم التحقق: أزيل منع المشاركة الخاص بتطبيقنا.";
            }
        } catch (Exception ex) {
            error = ex.getClass().getSimpleName() + ": " + String.valueOf(ex.getMessage());
            result = "لم تكتمل المزامنة: " + error;
        }
        Map<String, Object> state = new HashMap<>();
        state.put("device_owner", owner);
        state.put("applied_revision", applied);
        state.put("tethering_restricted", owner && dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_CONFIG_TETHERING));
        state.put("last_seen", FieldValue.serverTimestamp());
        state.put("model", Build.MANUFACTURER + " " + Build.MODEL);
        state.put("android_sdk", Build.VERSION.SDK_INT);
        BatteryManager battery = (BatteryManager) context.getSystemService(Context.BATTERY_SERVICE);
        state.put("battery_percent", battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY));
        state.put("error", error.length() > 1000 ? error.substring(0, 1000) : error);
        state.put("agent_version", "0.1.0-pilot");
        Tasks.await(db.collection("deviceStatus").document(uid).set(state), 25, TimeUnit.SECONDS);
        if (!error.isEmpty()) throw new IllegalStateException(error);
        return result;
    }
}

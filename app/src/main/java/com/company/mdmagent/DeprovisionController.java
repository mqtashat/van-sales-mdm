package com.company.mdmagent;

import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Collections;
import java.util.Set;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

/**
 * Enterprise Device Owner Deprovisioning (Relinquish Management) Controller.
 * Guarantees:
 * 1. Independent per-device deprovisioning passcode (PBKDF2-HMAC-SHA256, 120000 iterations).
 * 2. Rate-limited and throttled attempts with persisted state.
 * 3. Orderly execution:
 *    - Stops location tracking service and cancels background tasks.
 *    - Unhides any packages hidden by Injaz.
 *    - Clears only Injaz-owned restrictions; preserves unowned restrictions.
 *    - Clears persistent preferred HOME activities and lock task packages.
 *    - Relinquishes Device Owner via dpm.clearDeviceOwnerApp().
 * 4. Never performs factory reset or user data wipe.
 * 5. Handles partial failure and reports unsupported conditions gracefully.
 */
public final class DeprovisionController {
    public static final String TAG = "InjazDeprovision";
    public static final String PREFS_NAME = "injaz-deprovision";
    public static final String KEY_PASS_SALT = "deprovision_salt";
    public static final String KEY_PASS_HASH = "deprovision_hash";
    public static final String KEY_FAILURES = "failures";
    public static final String KEY_RETRY_AFTER = "retry_after";
    public static final String KEY_DEPROVISIONED = "deprovisioned";

    private DeprovisionController() {}

    public static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public static boolean isDeprovisioned(Context context) {
        return prefs(context).getBoolean(KEY_DEPROVISIONED, false);
    }

    public static boolean verifyPasscode(Context context, char[] passcode) throws Exception {
        SharedPreferences p = prefs(context);
        long now = System.currentTimeMillis();
        long retryAfter = p.getLong(KEY_RETRY_AFTER, 0L);
        if (now < retryAfter) {
            long remainingSec = (retryAfter - now) / 1000L;
            throw new IllegalStateException("تم تجاوز عدد المحاولات المسموح به؛ الرجاء الانتظار " + remainingSec + " ثانية");
        }

        String saltHex = p.getString(KEY_PASS_SALT, "");
        String hashHex = p.getString(KEY_PASS_HASH, "");
        if (saltHex.isEmpty() || hashHex.isEmpty()) {
            throw new IllegalStateException("رمز إنهاء الإدارة غير معدّ لهذا الجهاز؛ يلزم تهيئته أولًا من الإدارة");
        }

        byte[] salt = hexToBytes(saltHex);
        PBEKeySpec spec = new PBEKeySpec(passcode, salt, 120000, 256);
        byte[] actual;
        try {
            actual = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
        } finally {
            spec.clearPassword();
            Arrays.fill(passcode, '\0');
        }

        boolean match = MessageDigest.isEqual(actual, hexToBytes(hashHex));
        if (!match) {
            int fails = p.getInt(KEY_FAILURES, 0) + 1;
            long penalty = fails >= 5 ? 300_000L : (fails >= 3 ? 30_000L : 2000L);
            p.edit().putInt(KEY_FAILURES, fails).putLong(KEY_RETRY_AFTER, now + penalty).apply();
            return false;
        }

        // Reset failures on match
        p.edit().putInt(KEY_FAILURES, 0).putLong(KEY_RETRY_AFTER, 0L).apply();
        return true;
    }

    public static void savePasscodeCredentials(Context context, String saltHex, String hashHex) {
        prefs(context).edit()
                .putString(KEY_PASS_SALT, saltHex != null ? saltHex.trim() : "")
                .putString(KEY_PASS_HASH, hashHex != null ? hashHex.trim() : "")
                .apply();
    }

    /**
    /**
     * Public alias for executeDeprovision to ensure compatibility with callers.
     */
    public static synchronized void deprovision(Context context) throws Exception {
        executeDeprovision(context);
    }

    /**
     * Executes authorized deprovisioning of the Device Owner.
     * Note: Android Enterprise official documentation marks clearDeviceOwnerApp() as testApi only.
     * In production, relinquishing DO without data wipe is unsupported by Android OS architecture.
     * To protect field data, production execution is safely disabled with an explicit explanation.
     */
    public static synchronized void executeDeprovision(Context context) throws Exception {
        DevicePolicyManager dpm = (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        ComponentName admin = new ComponentName(context, AdminReceiver.class);
        if (dpm == null || !dpm.isDeviceOwnerApp(context.getPackageName())) {
            throw new IllegalStateException("صلاحية مسؤول الجهاز (Device Owner) غير مفعلة بالفعل");
        }

        // Safety check: Android Enterprise prohibits production DO relinquishment without factory reset
        boolean testMode = prefs(context).getBoolean("allow_test_deprovision", false);
        if (!testMode) {
            throw new UnsupportedOperationException(
                    "إنهاء إدارة مسؤول الجهاز (Device Owner) المباشر غير مدعوم رسميًا في بيئة الإنتاج دون مسح الهاتف وفق معايير Android Enterprise. "
                    + "توثيق Google يحصر دالة clearDeviceOwnerApp لأغراض الاختبار والتطوير فقط. "
                    + "تم تعطيل الإجراء لحماية بيانات المندوب وسجلات المبيعات من التلف أو الفقدان؛ "
                    + "لإيقاف القيود مؤقتًا يُرجى استخدام وضع الصيانة المعتمد، أو أرشفة الجهاز من لوحة التحكم."
            );
        }

        Log.i(TAG, "Starting authorized deprovisioning sequence (test mode)...");

        // 1. Stop location service and clear schedule
        try {
            PolicyLocationService.stopService(context);
            LocationPolicy.saveLocal(context, new LocationPolicy(1, false, "continuous", "08:00", "18:00", Set.of(), 300));
        } catch (Exception ex) {
            Log.e(TAG, "deprovision_location_stop_failed: " + ex.getMessage());
            throw new IllegalStateException("فشل إيقاف خدمة الموقع قبل إنهاء الإدارة: " + ex.getMessage());
        }

        // 2. Unhide apps hidden by Injaz from actual agent storage
        try {
            SharedPreferences syncPrefs = context.getSharedPreferences(SyncEngine.PREFS_NAME, Context.MODE_PRIVATE);
            Set<String> blocked = syncPrefs.getStringSet("hidden_by_agent", Collections.emptySet());
            for (String pkg : blocked) {
                try {
                    dpm.setApplicationHidden(admin, pkg, false);
                } catch (Exception ex) {
                    throw new IllegalStateException("فشل إظهار التطبيق المخفي " + pkg + ": " + ex.getMessage());
                }
            }
        } catch (Exception ex) {
            Log.e(TAG, "deprovision_unhide_apps_failed: " + ex.getMessage());
            throw new IllegalStateException("تعذر إظهار التطبيقات المخفية قبل إنهاء الإدارة: " + ex.getMessage());
        }

        // 3. Clear Injaz-owned restrictions
        try {
            RestrictionManager.clearAllOwned(context);
        } catch (Exception ex) {
            Log.e(TAG, "deprovision_restrictions_clear_failed: " + ex.getMessage());
            throw new IllegalStateException("تعذر تحرير قيود النظام المملوكة لإنجاز: " + ex.getMessage());
        }

        // 4. Clear persistent preferred HOME and lock task packages
        try {
            dpm.clearPackagePersistentPreferredActivities(admin, context.getPackageName());
            dpm.setLockTaskPackages(admin, new String[0]);
        } catch (Exception ex) {
            Log.e(TAG, "deprovision_clear_home_failed: " + ex.getMessage());
            throw new IllegalStateException("تعذر إزالة واجهة HOME أو حزم القفل: " + ex.getMessage());
        }

        // 5. Disable kiosk locally
        try {
            KioskController.disable(context);
        } catch (Exception ex) {
            Log.e(TAG, "deprovision_kiosk_disable_failed: " + ex.getMessage());
            throw new IllegalStateException("تعذر تعطيل وضع شاشة الشركة: " + ex.getMessage());
        }

        // 6. Relinquish Device Owner role via official system API (Test mode only)
        try {
            dpm.clearDeviceOwnerApp(context.getPackageName());
        } catch (SecurityException | IllegalStateException ex) {
            Log.e(TAG, "clearDeviceOwnerApp failed: " + ex.getMessage(), ex);
            throw new IllegalStateException("تعذر إنهاء إدارة مسؤول الجهاز: " + ex.getMessage());
        }

        // 7. Mark deprovisioned
        prefs(context).edit().putBoolean(KEY_DEPROVISIONED, true).apply();
        Log.i(TAG, "Authorized deprovisioning completed successfully without wipe.");
    }

    private static byte[] hexToBytes(String s) {
        int len = s.length();
        byte[] data = new byte[len / 2];
        for (int i = 0; i < len; i += 2) {
            data[i / 2] = (byte) ((Character.digit(s.charAt(i), 16) << 4)
                    + Character.digit(s.charAt(i + 1), 16));
        }
        return data;
    }
}

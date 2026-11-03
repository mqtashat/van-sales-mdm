package com.company.mdmagent;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.Map;

/**
 * Independent application install blocking policy.
 * When block_app_installs is true:
 * - DISALLOW_INSTALL_APPS and DISALLOW_INSTALL_UNKNOWN_SOURCES are enforced.
 * - Remains active during kiosk maintenance or when kiosk mode is completely disabled.
 */
public final class AppInstallPolicy {
    public static final String PREFS_NAME = "injaz-install-policy";
    public static final String KEY_REVISION = "revision";
    public static final String KEY_BLOCK_INSTALLS = "block_app_installs";

    public final long revision;
    public final boolean blockAppInstalls;

    public AppInstallPolicy(long revision, boolean blockAppInstalls) {
        this.revision = revision;
        this.blockAppInstalls = blockAppInstalls;
    }

    public static AppInstallPolicy parse(Map<String, Object> data, long currentRevision) {
        if (data == null) {
            throw new IllegalArgumentException("وثيقة سياسة التثبيت فارغة");
        }
        Object sv = data.get("schema_version");
        if (!(sv instanceof Number) || ((Number) sv).intValue() != 1) {
            throw new IllegalArgumentException("إصدار مخطط سياسة التثبيت غير صالح");
        }
        Object revObj = data.get("revision");
        if (!(revObj instanceof Number)) {
            throw new IllegalArgumentException("رقم إصدار سياسة التثبيت غير صالح");
        }
        long rev = ((Number) revObj).longValue();
        if (rev < 1) {
            throw new IllegalArgumentException("رقم الإصدار يجب أن يكون موجبًا");
        }
        if (rev < currentRevision) {
            throw new IllegalArgumentException("إصدار سياسة التثبيت أقدم من الإصدار الحالي");
        }
        Object blockObj = data.get("block_app_installs");
        if (!(blockObj instanceof Boolean)) {
            throw new IllegalArgumentException("حقل منع التثبيت يجب أن يكون قيمة منطقية (Boolean)");
        }
        return new AppInstallPolicy(rev, (Boolean) blockObj);
    }

    public static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public static AppInstallPolicy getLocal(Context context) {
        SharedPreferences p = prefs(context);
        long rev = p.getLong(KEY_REVISION, 0L);
        boolean block = p.getBoolean(KEY_BLOCK_INSTALLS, false);
        return new AppInstallPolicy(rev, block);
    }

    public static void saveLocal(Context context, AppInstallPolicy policy) {
        if (policy == null) return;
        boolean ok = prefs(context).edit()
                .putLong(KEY_REVISION, policy.revision)
                .putBoolean(KEY_BLOCK_INSTALLS, policy.blockAppInstalls)
                .commit();
        if (!ok) {
            throw new IllegalStateException("تعذر حفظ سياسة التثبيت محليًا");
        }
    }
}

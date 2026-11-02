package com.company.mdmagent;

import android.app.admin.DevicePolicyManager;
import android.content.*;
import android.content.pm.*;
import android.os.Process;
import android.provider.Settings;
import android.provider.Telephony;
import android.telecom.TelecomManager;
import android.view.inputmethod.InputMethodInfo;
import android.view.inputmethod.InputMethodManager;
import java.util.*;

final class AppRestrictions {
    interface Backend {
        String protectionReason(String pkg) throws Exception;
        boolean isHidden(String pkg) throws Exception;
        void setHidden(String pkg, boolean hidden) throws Exception;
    }
    interface Journal { boolean save(Set<String> packages); }

    // One result per failed package; never report a partial request as fully applied.
    static final class Result {
        final Map<String, String> failures = new LinkedHashMap<>();
        boolean complete() { return failures.isEmpty(); }
        String summary() {
            StringBuilder out = new StringBuilder();
            for (Map.Entry<String, String> item : failures.entrySet()) {
                if (out.length() > 0) out.append("; ");
                out.append(item.getKey()).append(": ").append(item.getValue());
            }
            return out.toString();
        }
    }

    static Result reconcile(Set<String> desired, Set<String> previous, Backend backend, Journal journal) {
        Result result = new Result();
        Set<String> tracked = new HashSet<>(previous);
        for (String pkg : new TreeSet<>(previous)) {
            if (desired.contains(pkg)) continue;
            try {
                // Restoring a package hidden by this agent is always allowed.
                backend.setHidden(pkg, false);
                if (backend.isHidden(pkg)) throw new IllegalStateException("تعذر تأكيد إلغاء الحظر");
                Set<String> next = new HashSet<>(tracked);
                next.remove(pkg);
                if (!journal.save(next)) throw new IllegalStateException("تعذر حفظ سجل الاستعادة");
                tracked = next;
            } catch (Exception ex) { result.failures.put(pkg, reason(ex)); }
        }
        for (String pkg : new TreeSet<>(desired)) {
            try {
                String protection = backend.protectionReason(pkg);
                if (protection != null) throw new IllegalArgumentException(protection);
                // Persist recovery intent before hiding; a crash cannot orphan a hidden app.
                Set<String> next = new HashSet<>(tracked);
                next.add(pkg);
                if (!journal.save(next)) throw new IllegalStateException("تعذر حفظ سجل الاستعادة؛ لم يُنفذ الحظر");
                tracked = next;
                backend.setHidden(pkg, true);
                if (!backend.isHidden(pkg)) throw new IllegalStateException("رفض النظام الحظر أو لم يؤكده");
            } catch (Exception ex) { result.failures.put(pkg, reason(ex)); }
        }
        return result;
    }

    private static String reason(Exception ex) {
        String msg = ex.getMessage();
        return ex.getClass().getSimpleName() + ": " + (msg == null ? "تعذر تنفيذ الإجراء" : msg);
    }

    static String classify(boolean protectedPackage, boolean coreUid, boolean platformSigned,
                           boolean persistent, boolean system, boolean launchable, boolean tracked) {
        if (protectedPackage) return "تطبيق أساسي أو مسؤول جهاز نشط؛ محمي";
        if (coreUid || platformSigned || persistent) return "مكوّن نظام أساسي؛ محمي";
        if (system && !launchable && !tracked) return "مكوّن نظام بلا واجهة تشغيل؛ يحتاج مراجعة قبل الحظر";
        return null;
    }

    static Result apply(Context context, DevicePolicyManager dpm, ComponentName admin,
                        Set<String> desired, SharedPreferences prefs) {
        Set<String> previous = new HashSet<>(prefs.getStringSet("hidden_by_agent", Collections.emptySet()));
        Backend backend = new Backend() {
            // Resolve lazily so protection discovery errors become per-app failures.
            @Override public String protectionReason(String pkg) throws Exception {
                PackageManager pm = context.getPackageManager();
                Set<String> protectedApps = protectedPackages(context, dpm);
                ApplicationInfo info;
                try { info = pm.getApplicationInfo(pkg, PackageManager.MATCH_UNINSTALLED_PACKAGES); }
                catch (PackageManager.NameNotFoundException ex) {
                    return "التطبيق غير موجود أو غير متاح للاستعلام؛ لم يُؤكد الحظر";
                }
                boolean system = (info.flags & (ApplicationInfo.FLAG_SYSTEM | ApplicationInfo.FLAG_UPDATED_SYSTEM_APP)) != 0;
                return classify(protectedApps.contains(pkg), info.uid % 100000 < Process.FIRST_APPLICATION_UID,
                        pm.checkSignatures("android", pkg) == PackageManager.SIGNATURE_MATCH,
                        (info.flags & ApplicationInfo.FLAG_PERSISTENT) != 0, system,
                        pm.getLaunchIntentForPackage(pkg) != null, previous.contains(pkg));
            }
            @Override public boolean isHidden(String pkg) { return dpm.isApplicationHidden(admin, pkg); }
            @Override public void setHidden(String pkg, boolean hidden) { dpm.setApplicationHidden(admin, pkg, hidden); }
        };
        return reconcile(desired, previous, backend,
                packages -> prefs.edit().putStringSet("hidden_by_agent", new HashSet<>(packages)).commit());
    }

    private static Set<String> protectedPackages(Context context, DevicePolicyManager dpm) {
        Set<String> out = new HashSet<>(Arrays.asList(context.getPackageName(), "android",
                "com.android.settings", "com.android.systemui", "com.android.phone", "com.android.server.telecom",
                "com.google.android.gms", "com.google.android.gsf", "com.android.vending",
                "com.android.permissioncontroller", "com.google.android.permissioncontroller",
                "com.android.packageinstaller", "com.google.android.packageinstaller",
                "com.android.providers.settings", "com.android.providers.telephony"));
        InputMethodManager ime = (InputMethodManager) context.getSystemService(Context.INPUT_METHOD_SERVICE);
        if (ime == null) throw new IllegalStateException("تعذر فحص لوحات المفاتيح المحمية");
        for (InputMethodInfo input : ime.getInputMethodList()) out.add(input.getPackageName());
        TelecomManager telecom = (TelecomManager) context.getSystemService(Context.TELECOM_SERVICE);
        if (telecom != null && telecom.getDefaultDialerPackage() != null) out.add(telecom.getDefaultDialerPackage());
        String sms = Telephony.Sms.getDefaultSmsPackage(context);
        if (sms != null) out.add(sms);
        List<ComponentName> admins = dpm.getActiveAdmins();
        if (admins != null) for (ComponentName active : admins) out.add(active.getPackageName());
        PackageManager pm = context.getPackageManager();
        for (ResolveInfo home : pm.queryIntentActivities(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), PackageManager.MATCH_DEFAULT_ONLY)) {
            if (home.activityInfo != null) out.add(home.activityInfo.packageName);
        }
        ResolveInfo settings = pm.resolveActivity(new Intent(Settings.ACTION_SETTINGS), PackageManager.MATCH_DEFAULT_ONLY);
        if (settings != null && settings.activityInfo != null) out.add(settings.activityInfo.packageName);
        return out;
    }
}

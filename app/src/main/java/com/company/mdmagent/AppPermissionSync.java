package com.company.mdmagent;

import android.app.admin.DevicePolicyManager;
import android.content.*;
import android.content.pm.*;
import android.util.Log;
import com.google.android.gms.tasks.Tasks;
import com.google.firebase.firestore.*;
import java.util.*;
import java.util.concurrent.TimeUnit;

final class AppPermissionSync {
    private AppPermissionSync() {}
    static int state(String value) {
        if ("granted".equals(value)) return DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED;
        if ("denied".equals(value)) return DevicePolicyManager.PERMISSION_GRANT_STATE_DENIED;
        return DevicePolicyManager.PERMISSION_GRANT_STATE_DEFAULT;
    }
    static void sync(Context context, FirebaseFirestore db, String uid) throws Exception {
        DevicePolicyManager dpm = (DevicePolicyManager)context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm == null || !dpm.isDeviceOwnerApp(context.getPackageName())) return;
        QuerySnapshot policies = Tasks.await(db.collection("appPermissionPolicies").document(uid)
                .collection("apps").limit(51).get(Source.SERVER), 15, TimeUnit.SECONDS);
        if (policies.size() > 50) throw new IllegalArgumentException("Permission policy exceeds 50 apps");
        PackageManager pm = context.getPackageManager();
        ComponentName admin = new ComponentName(context, AdminReceiver.class);
        Set<String> protectedPackages = AppRestrictions.protectedPackages(context, dpm);
        SharedPreferences prefs = context.getSharedPreferences("app-permission-state", 0);
        for (DocumentSnapshot doc : policies.getDocuments()) {
            String pkg = doc.getId();
            Map<String,Object> report = new HashMap<>();
            report.put("schema_version", 1L);
            report.put("revision", doc.get("revision") instanceof Long ? doc.getLong("revision") : 0L);
            report.put("permissions", Collections.emptyMap());
            report.put("error", "");
            String key = uid + ":" + pkg;
            try {
                if (!pkg.matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+") || pkg.length() > 150)
                    throw new IllegalArgumentException("Invalid package name");
                AppPermissionPolicy policy = AppPermissionPolicy.parse(doc.getData());
                long accepted = prefs.getLong(key + ":revision", 0);
                String fingerprint = policy.permissions.toString();
                if (policy.revision < accepted || (policy.revision == accepted
                        && !fingerprint.equals(prefs.getString(key + ":policy", ""))))
                    throw new IllegalArgumentException("Stale or conflicting permission revision");
                if (protectedPackages.contains(pkg) || pkg.equals(context.getPackageName()))
                    throw new IllegalArgumentException("لا يمكن تعديل أذونات مكوّن محمي من هذه الشاشة");
                if (!prefs.edit().putLong(key + ":revision", policy.revision)
                        .putString(key + ":policy", fingerprint).commit())
                    throw new IllegalStateException("تعذر حفظ مراجعة سياسة الأذونات");
                PackageInfo app = pm.getPackageInfo(pkg, PackageManager.GET_PERMISSIONS);
                Set<String> requested = new HashSet<>(Arrays.asList(app.requestedPermissions == null
                        ? new String[0] : app.requestedPermissions));
                Map<String,Map<String,String>> outcomes = AppPermissionPolicy.apply(policy, new AppPermissionPolicy.Backend() {
                    @Override public boolean requestedRuntimePermission(String permission) throws Exception {
                        if (!requested.contains(permission) || app.applicationInfo == null || app.applicationInfo.targetSdkVersion < 23) return false;
                        try {
                            PermissionInfo info = pm.getPermissionInfo(permission, 0);
                            return (info.protectionLevel & PermissionInfo.PROTECTION_MASK_BASE) == PermissionInfo.PROTECTION_DANGEROUS;
                        } catch (PackageManager.NameNotFoundException absent) { return false; }
                    }
                    @Override public boolean set(String permission, String desired) {
                        return dpm.setPermissionGrantState(admin, pkg, permission, state(desired));
                    }
                    @Override public String actual(String permission) {
                        int actual = dpm.getPermissionGrantState(admin, pkg, permission);
                        boolean granted = pm.checkPermission(permission, pkg) == PackageManager.PERMISSION_GRANTED;
                        if (actual == DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED) return granted ? "granted" : "unknown";
                        if (actual == DevicePolicyManager.PERMISSION_GRANT_STATE_DENIED) return !granted ? "denied" : "unknown";
                        return "default"; // releases admin enforcement, does not promise revocation
                    }
                });
                boolean complete = true;
                for (Map<String,String> row : outcomes.values()) if (!"applied".equals(row.get("status"))) complete = false;
                report.put("permissions", outcomes);
                report.put("status", complete ? "applied" : "needs_attention");
            } catch (PackageManager.NameNotFoundException missing) {
                report.put("status", "not_installed");
                report.put("error", "التطبيق غير مثبت أو غير متاح في مستخدم الجهاز الحالي");
            } catch (Exception ex) {
                report.put("status", "failed");
                String message = ex.getClass().getSimpleName() + ": " + String.valueOf(ex.getMessage());
                report.put("error", message.substring(0, Math.min(1000, message.length())));
            }
            String digest = new TreeMap<>(report).toString();
            long now = System.currentTimeMillis();
            if (digest.equals(prefs.getString(key + ":report", "")) && now - prefs.getLong(key + ":at", 0) < 3600000) continue;
            report.put("reported_at", FieldValue.serverTimestamp());
            report.put("agent_version", SyncEngine.AGENT_VERSION);
            try {
                Tasks.await(db.collection("appPermissionStatus").document(uid).collection("apps").document(pkg)
                        .set(report), 10, TimeUnit.SECONDS);
                prefs.edit().putString(key + ":report", digest).putLong(key + ":at", now).apply();
            } catch (Exception ex) { Log.w(SyncEngine.TAG, "permission_status_upload_failed", ex); }
        }
    }
}

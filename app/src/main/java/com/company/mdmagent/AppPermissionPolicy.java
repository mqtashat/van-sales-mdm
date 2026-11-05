package com.company.mdmagent;

import java.util.*;

/** Strict platform runtime-permission contract; never grants special access or global defaults. */
final class AppPermissionPolicy {
    static final Set<String> ALLOWED = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "android.permission.CAMERA", "android.permission.RECORD_AUDIO",
        "android.permission.READ_CONTACTS", "android.permission.WRITE_CONTACTS",
        "android.permission.ACCESS_COARSE_LOCATION", "android.permission.ACCESS_FINE_LOCATION",
        "android.permission.ACCESS_BACKGROUND_LOCATION", "android.permission.POST_NOTIFICATIONS",
        "android.permission.READ_CALENDAR", "android.permission.WRITE_CALENDAR",
        "android.permission.CALL_PHONE", "android.permission.READ_PHONE_STATE",
        "android.permission.READ_EXTERNAL_STORAGE", "android.permission.WRITE_EXTERNAL_STORAGE",
        "android.permission.READ_MEDIA_IMAGES", "android.permission.READ_MEDIA_VIDEO",
        "android.permission.READ_MEDIA_AUDIO", "android.permission.BLUETOOTH_CONNECT",
        "android.permission.BLUETOOTH_SCAN", "android.permission.ACTIVITY_RECOGNITION"
    )));
    final long revision;
    final SortedMap<String,String> permissions;
    private AppPermissionPolicy(long revision, SortedMap<String,String> permissions) {
        this.revision = revision;
        this.permissions = Collections.unmodifiableSortedMap(permissions);
    }
    static AppPermissionPolicy parse(Map<String,Object> doc) {
        if (doc == null || !Long.valueOf(1).equals(doc.get("schema_version"))
                || !(doc.get("revision") instanceof Long) || (Long)doc.get("revision") < 1
                || !(doc.get("permissions") instanceof Map)) throw new IllegalArgumentException("Invalid permission policy");
        Map<?,?> raw = (Map<?,?>)doc.get("permissions");
        if (raw.isEmpty() || raw.size() > ALLOWED.size()) throw new IllegalArgumentException("Invalid permission count");
        SortedMap<String,String> values = new TreeMap<>();
        for (Map.Entry<?,?> entry : raw.entrySet()) {
            if (!(entry.getKey() instanceof String) || !ALLOWED.contains(entry.getKey())
                    || !Arrays.asList("granted", "denied", "default").contains(entry.getValue()))
                throw new IllegalArgumentException("Unsupported permission or state");
            values.put((String)entry.getKey(), (String)entry.getValue());
        }
        return new AppPermissionPolicy((Long)doc.get("revision"), values);
    }
    interface Backend {
        boolean requestedRuntimePermission(String permission) throws Exception;
        boolean set(String permission, String desired) throws Exception;
        String actual(String permission) throws Exception;
    }
    static Map<String,Map<String,String>> apply(AppPermissionPolicy policy, Backend backend) {
        Map<String,Map<String,String>> result = new LinkedHashMap<>();
        // Foreground location must be processed before background location.
        List<String> ordered = new ArrayList<>(policy.permissions.keySet());
        if (ordered.remove("android.permission.ACCESS_BACKGROUND_LOCATION"))
            ordered.add("android.permission.ACCESS_BACKGROUND_LOCATION");
        for (String permission : ordered) {
            String desired = policy.permissions.get(permission);
            Map<String,String> row = new HashMap<>();
            row.put("requested", desired); row.put("actual", "unknown"); row.put("error", "");
            try {
                if (!backend.requestedRuntimePermission(permission)) {
                    row.put("status", "manual_required");
                    row.put("error", "الإذن غير مطلوب من التطبيق أو غير قابل للإدارة على إصدار النظام الحالي");
                } else {
                    boolean accepted = backend.set(permission, desired);
                    String actual = backend.actual(permission);
                    row.put("actual", actual);
                    if (accepted && desired.equals(actual)) row.put("status", "applied");
                    else {
                        row.put("status", "manual_required");
                        row.put("error", "لم يؤكد النظام تطبيق الإذن؛ يلزم مراجعة إعدادات التطبيق في الصيانة");
                    }
                }
            } catch (Exception ex) {
                row.put("status", "failed");
                String message = ex.getClass().getSimpleName() + ": " + String.valueOf(ex.getMessage());
                row.put("error", message.substring(0, Math.min(500, message.length())));
            }
            result.put(permission, row);
        }
        return result;
    }
}

package com.company.mdmagent;

import java.util.*;

/** Separate revision stream; absent, malformed or stale documents never unlock a device. */
final class KioskPolicy {
    final long revision;
    final boolean enabled;
    final Set<String> apps;
    final String salt, hash;
    KioskPolicy(long revision, boolean enabled, Set<String> apps, String salt, String hash) {
        this.revision = revision; this.enabled = enabled;
        this.apps = Collections.unmodifiableSet(new LinkedHashSet<>(apps)); this.salt = salt; this.hash = hash;
    }
    static KioskPolicy parse(Map<String, Object> data, long accepted) {
        if (data == null || !Long.valueOf(1).equals(data.get("schema_version"))
                || !(data.get("revision") instanceof Long) || (Long)data.get("revision") < Math.max(1, accepted)
                || !(data.get("enabled") instanceof Boolean)) throw new IllegalArgumentException("Invalid/stale kiosk policy");
        Object raw = data.get("allowed_apps");
        if (!(raw instanceof List) || ((List<?>)raw).size() > 50) throw new IllegalArgumentException("Invalid allowed_apps");
        Set<String> apps = new LinkedHashSet<>();
        for (Object p : (List<?>)raw) {
            if (!(p instanceof String) || ((String)p).length()>150
                    || !((String)p).matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+"))
                throw new IllegalArgumentException("Invalid allowed package");
            apps.add((String)p);
        }
        boolean enabled = (Boolean)data.get("enabled");
        String salt = data.get("exit_salt") instanceof String ? (String)data.get("exit_salt") : "";
        String hash = data.get("exit_hash") instanceof String ? (String)data.get("exit_hash") : "";
        if (!salt.matches("[a-f0-9]{32}") || !hash.matches("[a-f0-9]{64}") || (enabled && apps.isEmpty()))
            throw new IllegalArgumentException("Kiosk requires apps and a maintenance credential");
        return new KioskPolicy((Long)data.get("revision"), enabled, apps, salt, hash);
    }
    static boolean shouldApply(long incoming, long recoveryRevision) { return incoming > recoveryRevision; }
}

package com.company.mdmagent;

import java.util.Map;
import java.util.List;
import java.util.Set;
import java.util.HashSet;
import java.util.Collections;

/** Strict validation: incomplete or stale policies never silently unlock a device. */
final class Policy {
    final long revision;
    final boolean blockTethering;
    final Set<String> blockedApps;

    private Policy(long revision, boolean blockTethering, Set<String> blockedApps) {
        this.revision = revision;
        this.blockTethering = blockTethering;
        this.blockedApps = Collections.unmodifiableSet(blockedApps);
    }

    static Policy parse(Map<String, Object> data, long appliedRevision) {
        if (data == null || !Long.valueOf(1).equals(data.get("schema_version")))
            throw new IllegalArgumentException("schema_version must be integer 1");
        Object revision = data.get("revision");
        Object blocked = data.get("block_tethering");
        if (!(revision instanceof Long) || (Long) revision < 1)
            throw new IllegalArgumentException("revision must be a positive integer");
        if ((Long) revision < appliedRevision)
            throw new IllegalArgumentException("stale revision; increment revision to roll back");
        if (!(blocked instanceof Boolean))
            throw new IllegalArgumentException("block_tethering must be boolean");
        Object apps = data.get("blocked_apps");
        if (!(apps instanceof List) || ((List<?>) apps).size() > 50)
            throw new IllegalArgumentException("blocked_apps must be an array of up to 50 package names");
        Set<String> packages = new HashSet<>();
        for (Object value : (List<?>) apps) {
            if (!(value instanceof String) || !((String) value).matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+"))
                throw new IllegalArgumentException("invalid package in blocked_apps");
            packages.add((String) value);
        }
        return new Policy((Long) revision, (Boolean) blocked, packages);
    }
}

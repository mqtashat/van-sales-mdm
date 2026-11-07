package com.company.mdmagent;

/** Pure session gate. No historical import, numbers, or Firebase state stored here. */
final class CallLogPilotSession {
    static final long MAX_AGE_MS = 24L * 60 * 60 * 1000;
    static boolean valid(long started, long elapsedStart, String ownerUid, String currentUid,
                         long now, long elapsedNow) {
        return currentUid != null && !currentUid.isEmpty() && currentUid.equals(ownerUid)
                && started > 0 && now >= started && now - started < MAX_AGE_MS
                && elapsedStart >= 0 && elapsedNow >= elapsedStart
                && elapsedNow - elapsedStart < MAX_AGE_MS;
    }
    private CallLogPilotSession() {}
}

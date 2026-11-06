package com.company.mdmagent;

/** Conservative movement evidence, not map matching. Never fabricates coordinates. */
final class LocationQualityFilter {
    private boolean initialized, moving;
    private double latitude, longitude;
    private float accuracy;
    private long acceptedAt;
    boolean isMoving() { return moving; }
    void reset() { initialized = false; moving = false; }
    static boolean valid(double lat, double lon, float acc, long age, long time, long now) {
        return Double.isFinite(lat) && Double.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
                && Float.isFinite(acc) && acc > 0 && acc <= 35 && age >= 0 && age <= 30_000
                && time > 0 && Math.abs(now - time) <= 30_000;
    }
    boolean accept(double lat, double lon, float acc, long now) {
        if (initialized && now - acceptedAt > 300_000) reset(); // New segment after signal gap.
        if (initialized) {
            double distance = distance(latitude, longitude, lat, lon);
            long elapsed = now - acceptedAt;
            if (elapsed <= 0 || elapsed < 25_000) return false;
            if (distance > 60 * (elapsed / 1000.0) + accuracy + acc) return false;
            moving = distance > Math.max(20, accuracy + acc);
            if (!moving) return false; // Keep anchor: drift cannot form a false journey.
        }
        initialized = true; latitude = lat; longitude = lon; accuracy = acc; acceptedAt = now;
        return true;
    }
    static double distance(double a, double b, double c, double d) {
        double x = Math.toRadians(c-a), y = Math.toRadians(d-b);
        double h = Math.sin(x/2)*Math.sin(x/2) + Math.cos(Math.toRadians(a))*Math.cos(Math.toRadians(c))*Math.sin(y/2)*Math.sin(y/2);
        return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
    }
}

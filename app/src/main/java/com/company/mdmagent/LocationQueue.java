package com.company.mdmagent;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import com.google.android.gms.tasks.Tasks;
import com.google.firebase.firestore.FieldValue;
import com.google.firebase.firestore.FirebaseFirestore;
import com.google.firebase.firestore.WriteBatch;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Bounded, persistent offline queue for captured location points.
 * Retains points during network drops, limits size to prevent storage exhaustion,
 * and handles batch uploads with idempotency keys.
 */
public final class LocationQueue {
    public static final String PREFS_NAME = "injaz-location-queue";
    public static final String KEY_QUEUE = "pending_points_json";
    public static final int MAX_QUEUE_SIZE = 500;

    public static final class Point {
        public final String pointId;
        public final long recordedAt;
        public final double latitude;
        public final double longitude;
        public final float accuracyMeters;
        public final float speedMps;
        public final int batteryPercent;

        public Point(String pointId, long recordedAt, double latitude, double longitude,
                     float accuracyMeters, float speedMps, int batteryPercent) {
            this.pointId = pointId != null ? pointId : UUID.randomUUID().toString();
            this.recordedAt = recordedAt;
            this.latitude = latitude;
            this.longitude = longitude;
            this.accuracyMeters = accuracyMeters;
            this.speedMps = speedMps;
            this.batteryPercent = batteryPercent;
        }

        JSONObject toJson() throws Exception {
            JSONObject obj = new JSONObject();
            obj.put("id", pointId);
            obj.put("time", recordedAt);
            obj.put("lat", latitude);
            obj.put("lng", longitude);
            obj.put("acc", (double) accuracyMeters);
            obj.put("spd", (double) speedMps);
            obj.put("bat", batteryPercent);
            return obj;
        }

        static Point fromJson(JSONObject obj) {
            return new Point(
                    obj.optString("id", UUID.randomUUID().toString()),
                    obj.optLong("time", System.currentTimeMillis()),
                    obj.optDouble("lat", 0.0),
                    obj.optDouble("lng", 0.0),
                    (float) obj.optDouble("acc", 0.0),
                    (float) obj.optDouble("spd", 0.0),
                    obj.optInt("bat", 0)
            );
        }
    }

    private LocationQueue() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private static String getQueueKey(String uid) {
        return KEY_QUEUE + (uid != null && !uid.isEmpty() ? "_" + uid : "");
    }

    public static synchronized void enqueue(Context context, String uid, Point point) {
        if (point == null || uid == null || uid.isEmpty()) return;
        List<Point> current = loadPoints(context, uid);

        // FIFO eviction if capacity exceeded
        while (current.size() >= MAX_QUEUE_SIZE) {
            current.remove(0);
        }
        current.add(point);
        savePoints(context, uid, current);
    }

    public static synchronized int getQueueSize(Context context, String uid) {
        return loadPoints(context, uid).size();
    }

    public static synchronized List<Point> loadPoints(Context context, String uid) {
        String jsonStr = prefs(context).getString(getQueueKey(uid), "[]");
        List<Point> list = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(jsonStr);
            for (int i = 0; i < arr.length(); i++) {
                list.add(Point.fromJson(arr.getJSONObject(i)));
            }
        } catch (Exception ex) {
            // corrupted queue
            list.clear();
        }
        return list;
    }

    private static synchronized void savePoints(Context context, String uid, List<Point> points) {
        JSONArray arr = new JSONArray();
        for (Point p : points) {
            try { arr.put(p.toJson()); } catch (Exception ignored) {}
        }
        prefs(context).edit().putString(getQueueKey(uid), arr.toString()).apply();
    }

    /**
     * Extracts a batch of points under lock without holding the lock during network transmission.
     */
    public static synchronized List<Point> extractBatch(Context context, String uid, int maxBatch) {
        if (uid == null || uid.isEmpty()) return Collections.emptyList();
        List<Point> current = loadPoints(context, uid);
        if (current.isEmpty()) return Collections.emptyList();
        int toProcessCount = Math.min(maxBatch, Math.min(25, current.size()));
        return new ArrayList<>(current.subList(0, toProcessCount));
    }

    /**
     * Removes only confirmed point IDs under lock after successful Firestore commit.
     */
    public static synchronized void removeConfirmed(Context context, String uid, java.util.Set<String> confirmedIds) {
        if (uid == null || uid.isEmpty() || confirmedIds == null || confirmedIds.isEmpty()) return;
        List<Point> current = loadPoints(context, uid);
        List<Point> remaining = new ArrayList<>();
        for (Point p : current) {
            if (!confirmedIds.contains(p.pointId)) {
                remaining.add(p);
            }
        }
        savePoints(context, uid, remaining);
    }

    /**
     * Drains up to maxBatch points to Firestore under deviceLocations/{uid}/points/{pointId}.
     * Separates batch taking, network commit, and deletion without holding the monitor lock across network calls.
     * Uses deterministic point IDs for idempotent retransmissions after drops.
     */
    public static int drainToFirestore(Context context, FirebaseFirestore db, String uid, int maxBatch) throws Exception {
        if (uid == null || uid.isEmpty()) return 0;
        if (!SyncEngine.isDeviceApproved(context, uid)) return 0;

        List<Point> batchPoints = extractBatch(context, uid, maxBatch);
        if (batchPoints.isEmpty()) return 0;

        List<String> pointIds = new ArrayList<>();
        for (Point p : batchPoints) {
            pointIds.add(p.pointId);
        }

        // 1. Identify points that were already committed to Firestore (e.g. previous network drop before response ACK)
        java.util.Set<String> alreadyCommittedIds = new java.util.HashSet<>();
        try {
            com.google.firebase.firestore.QuerySnapshot existingSnap = Tasks.await(
                    db.collection("deviceLocations").document(uid).collection("points")
                            .whereIn(com.google.firebase.firestore.FieldPath.documentId(), pointIds)
                            .get(com.google.firebase.firestore.Source.SERVER),
                    15,
                    TimeUnit.SECONDS
            );
            if (existingSnap != null && !existingSnap.isEmpty()) {
                for (com.google.firebase.firestore.DocumentSnapshot docSnap : existingSnap.getDocuments()) {
                    alreadyCommittedIds.add(docSnap.getId());
                }
            }
        } catch (Exception ex) {
            Log.w("LocationQueue", "existing_points_check_failed: " + ex.getMessage());
        }

        // Acknowledge existing points immediately without mutating data or original timestamps
        java.util.Set<String> confirmedIds = new java.util.HashSet<>(alreadyCommittedIds);

        WriteBatch batch = db.batch();
        long now = System.currentTimeMillis();
        int newPointsCount = 0;

        for (Point p : batchPoints) {
            if (alreadyCommittedIds.contains(p.pointId)) {
                continue; // Do not attempt rewrite; respects allow update: if false
            }

            Map<String, Object> doc = new HashMap<>();
            doc.put("point_id", p.pointId);
            doc.put("latitude", p.latitude);
            doc.put("longitude", p.longitude);
            doc.put("accuracy_meters", p.accuracyMeters);
            doc.put("speed_mps", p.speedMps);
            doc.put("battery_percent", p.batteryPercent);
            doc.put("recorded_at", new java.util.Date(p.recordedAt));
            doc.put("received_at", FieldValue.serverTimestamp());
            doc.put("is_delayed_sync", (now - p.recordedAt) > 120_000L);

            com.google.firebase.firestore.DocumentReference docRef = db.collection("deviceLocations")
                    .document(uid).collection("points").document(p.pointId);
            batch.set(docRef, doc);
            confirmedIds.add(p.pointId);
            newPointsCount++;
        }

        if (newPointsCount > 0) {
            // Network commit WITHOUT holding LocationQueue class lock
            Tasks.await(batch.commit(), 25, TimeUnit.SECONDS);
        }

        // Delete confirmed points under lock (both previously existing and newly committed)
        removeConfirmed(context, uid, confirmedIds);

        return batchPoints.size();
    }
}

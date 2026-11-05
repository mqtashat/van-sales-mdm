package com.company.mdmagent;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import com.google.android.gms.tasks.Tasks;
import com.google.firebase.firestore.*;
import java.util.*;
import java.util.concurrent.TimeUnit;

/** Optional remote refresh contract; missing/new rules never block the existing inventory upload. */
final class InventorySync {
    private InventorySync() {}
    static void sync(Context context, FirebaseFirestore db, String uid, String trigger) {
        SharedPreferences prefs = context.getSharedPreferences("inventory-state", 0);
        String requestId = "";
        try {
            DocumentSnapshot request = Tasks.await(db.collection("inventoryRefreshRequests").document(uid)
                    .get(Source.SERVER), 10, TimeUnit.SECONDS);
            Object id = request.get("request_id");
            if (id instanceof String && ((String)id).matches("[A-Za-z0-9_-]{1,128}")) requestId = (String)id;
        } catch (Exception ex) {
            Log.w(SyncEngine.TAG, "inventory_refresh_request_unavailable", ex);
        }
        boolean requested = !requestId.isEmpty() && !requestId.equals(prefs.getString("completed_request", ""));
        boolean manual = "kiosk_refresh".equals(trigger) || "manual".equals(trigger) || "direct".equals(trigger)
                || trigger.contains("manual") || "inventory_refresh_requested".equals(trigger);
        String state = "success", error = "";
        try {
            DeviceInventory.publish(context, db, uid, requested || manual);
        } catch (Exception ex) {
            state = "failed";
            error = ex.getClass().getSimpleName() + ": " + String.valueOf(ex.getMessage());
            if (error.length() > 1000) error = error.substring(0, 1000);
            DeviceInventory.markDirty(context);
            Log.w(SyncEngine.TAG, "inventory_upload_failed", ex);
        }
        // Persist reporting failures for local maintenance diagnostics, independently of cloud rules.
        prefs.edit().putString("last_error", error).apply();
        Map<String,Object> result = new HashMap<>();
        result.put("schema_version", 1L);
        result.put("request_id", requestId);
        result.put("status", state);
        result.put("error", error);
        result.put("reported_at", FieldValue.serverTimestamp());
        result.put("agent_version", SyncEngine.AGENT_VERSION);
        try {
            Tasks.await(db.collection("deviceInventoryStatus").document(uid).set(result), 10, TimeUnit.SECONDS);
            if (requested && "success".equals(state)) prefs.edit().putString("completed_request", requestId).apply();
        } catch (Exception ex) {
            Log.w(SyncEngine.TAG, "inventory_status_upload_failed", ex);
        }
    }
}

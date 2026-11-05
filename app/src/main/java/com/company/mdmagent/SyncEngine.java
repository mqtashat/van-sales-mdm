package com.company.mdmagent;

import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.UserManager;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;
import com.google.android.gms.tasks.Tasks;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseUser;
import com.google.firebase.firestore.DocumentSnapshot;
import com.google.firebase.firestore.FieldValue;
import android.location.LocationManager;
import android.Manifest;
import com.google.firebase.firestore.QueryDocumentSnapshot;
import com.google.firebase.firestore.QuerySnapshot;
import com.google.firebase.firestore.Source;
import com.google.firebase.firestore.FirebaseFirestore;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;

final class SyncEngine {
    static boolean isLocationSwitchEnabled(android.location.LocationManager manager) {
        if (manager == null) return false;
        if (android.os.Build.VERSION.SDK_INT >= 28) return manager.isLocationEnabled();
        return manager.isProviderEnabled(android.location.LocationManager.GPS_PROVIDER)
                || manager.isProviderEnabled(android.location.LocationManager.NETWORK_PROVIDER);
    }

    static final String TAG = "InjazMdmAgent";
    static final String AGENT_VERSION = "0.5.4-pilot";
    static final String PREFS_NAME = "applied-policy";
    static final String KEY_REVISION = "revision";
    static final String KEY_APPROVED_VERIFIED = "approved_verified";
    static final String KEY_APPROVED_UID = "approved_uid";

    interface StatusListener {
        void onSyncStatusUpdated(boolean inProgress, String message);
    }

    interface SyncExecutor {
        void execute(Runnable command);
    }

    interface SyncAction {
        String run(String trigger) throws Exception;
    }

    /**
     * Race-free atomic sync queue coordinator.
     * Both the pending-check and the running-flag reset happen inside the same
     * synchronized(lock) critical section, making it impossible for a request arriving
     * during queue completion to be dropped.
     */
    static final class QueueCoordinator {
        private final Object lock = new Object();
        private final SyncExecutor executor;
        private final SyncAction action;
        private final StatusListener statusCallback;

        private boolean running = false;
        private boolean pending = false;
        private String pendingTrigger = "";
        private String lastStatusMessage = "";
        private volatile Runnable completionHookForTest = null;

        QueueCoordinator(SyncExecutor executor, SyncAction action, StatusListener statusCallback) {
            this.executor = executor;
            this.action = action;
            this.statusCallback = statusCallback;
        }

        void setCompletionHookForTest(Runnable hook) {
            this.completionHookForTest = hook;
        }

        boolean isRunning() {
            synchronized (lock) {
                return running;
            }
        }

        String getLastStatusMessage() {
            synchronized (lock) {
                return lastStatusMessage;
            }
        }

        void setLastStatusMessage(String message) {
            synchronized (lock) {
                lastStatusMessage = message != null ? message : "";
            }
        }

        /**
         * Submits a sync request.
         * @return true if a new worker loop was dispatched; false if coalesced into the active loop.
         */
        boolean submit(String trigger) {
            final String safeTrigger = (trigger != null && !trigger.isEmpty()) ? trigger : "unspecified";
            synchronized (lock) {
                if (running) {
                    pending = true;
                    pendingTrigger = safeTrigger;
                    return false;
                }
                running = true;
                pending = false;
                pendingTrigger = "";
            }
            if (statusCallback != null) {
                statusCallback.onSyncStatusUpdated(true, "جارٍ التحقق من الخادم…");
            }
            executor.execute(() -> drain(safeTrigger));
            return true;
        }

        private void drain(String initialTrigger) {
            String currentTrigger = initialTrigger;
            while (true) {
                String message;
                try {
                    message = action.run(currentTrigger);
                } catch (Exception ex) {
                    message = "تعذر إكمال المزامنة؛ لا تفترض تطبيق سياسة جديدة.\n" + String.valueOf(ex.getMessage());
                }
                final String completedMessage = message != null ? message : "";
                synchronized (lock) {
                    lastStatusMessage = completedMessage;
                    Runnable hook = completionHookForTest;
                    if (hook != null) {
                        hook.run();
                    }
                    if (pending) {
                        currentTrigger = pendingTrigger;
                        pending = false;
                        pendingTrigger = "";
                    } else {
                        running = false;
                        if (statusCallback != null) {
                            statusCallback.onSyncStatusUpdated(false, completedMessage);
                        }
                        return;
                    }
                }
            }
        }
    }

    static final class EnrollmentRecord {
        final boolean exists;
        final Boolean approved;

        EnrollmentRecord(boolean exists, Boolean approved) {
            this.exists = exists;
            this.approved = approved;
        }
    }

    interface ServerEnrollmentProvider {
        String getCurrentUid();
        EnrollmentRecord fetchServerEnrollment(String uid) throws Exception;
    }

    private static final ServerEnrollmentProvider DEFAULT_ENROLLMENT_PROVIDER = new ServerEnrollmentProvider() {
        @Override
        public String getCurrentUid() {
            FirebaseUser user = FirebaseAuth.getInstance().getCurrentUser();
            return user != null ? user.getUid() : null;
        }

        @Override
        public EnrollmentRecord fetchServerEnrollment(String uid) throws Exception {
            DocumentSnapshot enrollment = Tasks.await(
                    FirebaseFirestore.getInstance().collection("enrollments").document(uid).get(Source.SERVER),
                    25,
                    TimeUnit.SECONDS
            );
            return new EnrollmentRecord(enrollment.exists(), enrollment.getBoolean("approved"));
        }
    };

    private static volatile ServerEnrollmentProvider enrollmentProvider = DEFAULT_ENROLLMENT_PROVIDER;
    private static volatile StatusListener statusListener;
    private static volatile StatusListener directStatusListenerForTest;
    private static volatile Context activeAppContext;

    static void setEnrollmentProviderForTest(ServerEnrollmentProvider provider) {
        enrollmentProvider = provider != null ? provider : DEFAULT_ENROLLMENT_PROVIDER;
    }

    static void setDirectStatusListenerForTest(StatusListener listener) {
        directStatusListenerForTest = listener;
    }

    static String getCurrentAuthenticatedUid() {
        return enrollmentProvider.getCurrentUid();
    }

    private static final QueueCoordinator COORDINATOR = new QueueCoordinator(
            command -> AgentApp.SYNC.execute(command),
            trigger -> {
                Context ctx = activeAppContext;
                if (ctx == null) {
                    throw new IllegalStateException("Context not initialized");
                }
                try {
                    return sync(ctx, trigger);
                } catch (Exception ex) {
                    SyncRecovery.schedule(ctx, ex);
                    throw ex;
                }
            },
            (inProgress, message) -> notifyStatus(inProgress, message)
    );

    private SyncEngine() {
    }

    private static void postToMainThread(Runnable action) {
        try {
            Looper mainLooper = Looper.getMainLooper();
            if (mainLooper != null) {
                new Handler(mainLooper).post(action);
            }
        } catch (RuntimeException ignored) {
            // In local JVM unit tests where android.os.Looper is not mocked
        }
    }

    static void setStatusListener(StatusListener listener) {
        statusListener = listener;
        if (listener != null) {
            boolean busy = COORDINATOR.isRunning();
            String msg = COORDINATOR.getLastStatusMessage();
            postToMainThread(() -> {
                StatusListener current = statusListener;
                if (current != null && msg != null && !msg.isEmpty()) {
                    current.onSyncStatusUpdated(busy, msg);
                }
            });
        }
    }

    static boolean isSyncInProgress() {
        return COORDINATOR.isRunning();
    }

    static String getLastStatusMessage() {
        return COORDINATOR.getLastStatusMessage();
    }

    /**
     * Single source of truth for whether the Foreground Service is allowed to run.
     * Strictly requires Device Owner (isDeviceOwnerApp), a non-empty authenticated UID,
     * and server-verified approval for that exact UID.
     */
    static boolean canStartServiceForState(
            boolean isDeviceOwner,
            String currentUid,
            boolean approvedVerified,
            String approvedUid
    ) {
        if (!isDeviceOwner) return false;
        if (currentUid == null || currentUid.trim().isEmpty()) return false;
        if (!approvedVerified) return false;
        return currentUid.equals(approvedUid);
    }

    static boolean isDeviceApproved(Context context, String currentUid) {
        if (context == null || currentUid == null || currentUid.isEmpty()) return false;
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        boolean approvedVerified = prefs.getBoolean(KEY_APPROVED_VERIFIED, false);
        String approvedUid = prefs.getString(KEY_APPROVED_UID, "");
        return canStartServiceForState(true, currentUid, approvedVerified, approvedUid);
    }

    static void recordApprovalState(SharedPreferences prefs, String uid, boolean approved) {
        if (prefs == null) return;
        prefs.edit()
                .putBoolean(KEY_APPROVED_VERIFIED, approved)
                .putString(KEY_APPROVED_UID, approved && uid != null ? uid : "")
                .apply();
    }

    /**
     * Submits a sync request through the atomic QueueCoordinator.
     */
    static void requestSync(Context context, String trigger) {
        if (context == null) return;
        activeAppContext = context.getApplicationContext();
        String safeTrigger = (trigger != null && !trigger.isEmpty()) ? trigger : "unspecified";
        boolean startedNew = COORDINATOR.submit(safeTrigger);
        if (!startedNew) {
            Log.i(TAG, "sync_coalesced: already running, queued trigger=" + safeTrigger);
        }
    }

    private static void notifyStatus(boolean inProgress, String message) {
        StatusListener direct = directStatusListenerForTest;
        if (direct != null) {
            direct.onSyncStatusUpdated(inProgress, message);
        }
        postToMainThread(() -> {
            StatusListener current = statusListener;
            if (current != null) {
                current.onSyncStatusUpdated(inProgress, message);
            }
        });
    }

    static synchronized String sync(Context context) throws Exception {
        return sync(context, "direct");
    }

    /**
     * Serializes worker + foreground service + manual UI syncs.
     * Always reads enrollment and policy documents from Source.SERVER; never applies from cache.
     */
    static synchronized String sync(Context context, String trigger) throws Exception {
        String safeTrigger = (trigger != null && !trigger.isEmpty()) ? trigger : "direct";
        long startedAt = SystemClock.elapsedRealtime();
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        Log.i(TAG, "sync_start: trigger=" + safeTrigger
                + " interactive=" + (power != null && power.isInteractive())
                + " idle=" + (power != null && power.isDeviceIdleMode()));

        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        ServerEnrollmentProvider provider = enrollmentProvider;
        String uid = provider.getCurrentUid();
        if (uid == null || uid.isEmpty()) {
            recordApprovalState(prefs, null, false);
            PolicySyncService.stopIfRunning(context, "sync_unauthenticated");
            Log.w(TAG, "sync_skip_unauthenticated: trigger=" + safeTrigger);
            String msg = "افتح التطبيق وسجّل جهاز التجربة أولًا.";
            COORDINATOR.setLastStatusMessage(msg);
            return msg;
        }

        EnrollmentRecord enrollment;
        try {
            enrollment = provider.fetchServerEnrollment(uid);
        } catch (Exception ex) {
            Log.w(TAG, "sync_enrollment_check_failed: trigger=" + safeTrigger
                    + " type=" + ex.getClass().getSimpleName()
                    + " message=" + String.valueOf(ex.getMessage()));
            throw ex;
        }

        if (enrollment == null || !enrollment.exists || !Boolean.TRUE.equals(enrollment.approved)) {
            recordApprovalState(prefs, uid, false);
            PolicySyncService.stopIfRunning(context, "enrollment_not_approved");
            Log.w(TAG, "sync_unapproved: enrollment missing or false, trigger=" + safeTrigger);
            String msg = "بانتظار اعتماد الجهاز في Firebase؛ القيود الحالية لا تتغير.";
            COORDINATOR.setLastStatusMessage(msg);
            return msg;
        }

        // Server confirmed enrollment approval
        recordApprovalState(prefs, uid, true);
        FirebaseFirestore db = FirebaseFirestore.getInstance();
        try {
            PackageInstallManager.recoverPendingInstallTasks(context);
        } catch (Exception ex) {
            Log.w(TAG, "install_recovery_failed: " + ex.getMessage());
        }

        DevicePolicyManager dpm = (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        ComponentName admin = new ComponentName(context, AdminReceiver.class);
        boolean owner = dpm != null && dpm.isDeviceOwnerApp(context.getPackageName());
        if (owner) PushRegistration.refresh(context);
        long applied = prefs.getLong(KEY_REVISION, 0);
        String error = "";
        Exception policyFailure = null;
        String result;

        try {
            DocumentSnapshot snapshot = Tasks.await(
                    db.collection("policies").document(uid).get(Source.SERVER),
                    25,
                    TimeUnit.SECONDS
            );
            if (!snapshot.exists()) {
                result = "الجهاز معتمد؛ لم تُنشأ سياسة بعد. لا تغيير في القيود.";
                Log.i(TAG, "sync_no_policy_doc: trigger=" + safeTrigger + " appliedRevision=" + applied);
            } else {
                Policy policy = Policy.parse(snapshot.getData(), Math.max(applied, prefs.getLong("accepted_revision", 0)));
                if (!owner) {
                    throw new IllegalStateException("Device Owner غير مفعّل؛ لم تطبّق السياسة.");
                }
                // Remember newest accepted revision even if some components fail: never replay older policy.
                if (!prefs.edit().putLong("accepted_revision", policy.revision).commit()) {
                    throw new IllegalStateException("تعذر حفظ إصدار السياسة؛ لم تُنفذ تغييرات جديدة");
                }
                PolicyApplication.Result execution = PolicyApplication.apply(() -> {
                    if (policy.blockTethering) {
                        dpm.addUserRestriction(admin, UserManager.DISALLOW_CONFIG_TETHERING);
                    } else {
                        dpm.clearUserRestriction(admin, UserManager.DISALLOW_CONFIG_TETHERING);
                    }
                    if (dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_CONFIG_TETHERING) != policy.blockTethering) {
                        throw new IllegalStateException("تعذر التحقق من تطبيق القيد");
                    }
                }, () -> AppRestrictions.apply(context, dpm, admin, policy.blockedApps, prefs));
                boolean actual = dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_CONFIG_TETHERING);
                if (!execution.complete()) {
                    // Keep applied_revision at the last completely confirmed revision.
                    // Existing error field communicates partial application without changing Firestore schema.
                    throw new IllegalStateException("لم تكتمل السياسة #" + policy.revision
                            + "; مشاركة الإنترنت " + (actual ? "ممنوعة" : "غير ممنوعة بقيد إنجاز")
                            + "; " + execution.error());
                }
                if (!prefs.edit().putLong(KEY_REVISION, policy.revision).commit()) {
                    throw new IllegalStateException("تعذر حفظ تأكيد اكتمال السياسة");
                }
                applied = policy.revision;
                result = actual
                        ? "تم التحقق: مشاركة الإنترنت ممنوعة والتطبيقات المطلوبة عولجت."
                        : "تم التحقق: أزيل منع المشاركة الخاص بتطبيقنا والتطبيقات المطلوبة عولجت.";
                Log.i(TAG, "sync_policy_applied: trigger=" + safeTrigger
                        + " revision=" + applied
                        + " blockTethering=" + actual
                        + " blockedAppsCount=" + policy.blockedApps.size());
            }
        } catch (Exception ex) {
            policyFailure = ex;
            error = ex.getClass().getSimpleName() + ": " + String.valueOf(ex.getMessage());
            result = "لم تكتمل المزامنة: " + error;
            Log.e(TAG, "sync_apply_error: trigger=" + safeTrigger + " error=" + error);
        }

        if (owner) {
            // Optional features cannot prevent the existing tethering/app policy or its status upload.
            String kioskError = KioskController.synchronize(context, db, uid);
            if (!kioskError.isEmpty()) Log.w(TAG, "kiosk_sync: " + kioskError);
            InventorySync.sync(context, db, uid, safeTrigger);
            try { AppPermissionSync.sync(context, db, uid); }
            catch (Exception permissionError) { Log.w(TAG, "app_permission_sync_unavailable", permissionError); }

            // 1. Sync AppInstallPolicy
            try {
                DocumentSnapshot installDoc = Tasks.await(
                        db.collection("appInstallPolicies").document(uid).get(Source.SERVER),
                        15,
                        TimeUnit.SECONDS
                );
                if (installDoc != null && installDoc.exists()) {
                    AppInstallPolicy installPolicy = AppInstallPolicy.parse(
                            installDoc.getData(),
                            AppInstallPolicy.getLocal(context).revision
                    );
                    AppInstallPolicy.saveLocal(context, installPolicy);
                }
            } catch (Exception ex) {
                Log.w(TAG, "install_policy_sync_failed: " + ex.getMessage());
            }

            // 2. Sync LocationPolicy
            try {
                DocumentSnapshot locDoc = Tasks.await(
                        db.collection("locationPolicies").document(uid).get(Source.SERVER),
                        15,
                        TimeUnit.SECONDS
                );
                if (locDoc != null && locDoc.exists()) {
                    LocationPolicy locPolicy = LocationPolicy.parse(
                            locDoc.getData(),
                            LocationPolicy.getLocal(context).revision
                    );
                    LocationPolicy.saveLocal(context, locPolicy);
                }
            } catch (Exception ex) {
                Log.w(TAG, "location_policy_sync_failed: " + ex.getMessage());
            }

            // 3. Reconcile restrictions across all active features
            try {
                boolean kioskActive = KioskController.enabled(context) && !KioskController.inMaintenance(context);
                boolean blockInstalls = AppInstallPolicy.getLocal(context).blockAppInstalls;
                boolean blockTether = dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_CONFIG_TETHERING);
                LocationPolicy currentLoc = LocationPolicy.getLocal(context);
                boolean blockLocConfig = currentLoc.enabled;

                if (currentLoc.enabled) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                        try {
                            dpm.setLocationEnabled(admin, true);
                        } catch (Exception e) {
                            Log.w(TAG, "setLocationEnabled failed: " + e.getMessage());
                        }
                    }
                    try {
                        dpm.setPermissionGrantState(admin, context.getPackageName(), Manifest.permission.ACCESS_FINE_LOCATION, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED);
                        dpm.setPermissionGrantState(admin, context.getPackageName(), Manifest.permission.ACCESS_COARSE_LOCATION, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED);
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                            dpm.setPermissionGrantState(admin, context.getPackageName(), Manifest.permission.ACCESS_BACKGROUND_LOCATION, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED);
                        }
                    } catch (Exception e) {
                        Log.w(TAG, "grantLocationPermissions failed: " + e.getMessage());
                    }
                    PolicyLocationService.startIfPolicyEnabled(context);
                } else {
                    PolicyLocationService.stopService(context);
                }

                Set<String> required = RestrictionManager.computeRequiredRestrictions(
                        context,
                        kioskActive,
                        blockInstalls,
                        blockTether,
                        blockLocConfig
                );
                RestrictionManager.reconcile(context, required);
            } catch (Exception ex) {
                Log.w(TAG, "restriction_reconcile_failed: " + ex.getMessage());
            }

            // 4. Drain queued location points
            try {
                LocationQueue.drainToFirestore(context, db, uid, 25);
            } catch (Exception ex) {
                Log.w(TAG, "location_queue_drain_failed: " + ex.getMessage());
            }

            // 5. Process pending deviceCommands
            try {
                QuerySnapshot cmdSnap = Tasks.await(
                        db.collection("deviceCommands").document(uid).collection("commands")
                                .whereEqualTo("status", "pending")
                                .get(Source.SERVER),
                        15,
                        TimeUnit.SECONDS
                );
                if (cmdSnap != null && !cmdSnap.isEmpty()) {
                    for (QueryDocumentSnapshot cmdDoc : cmdSnap) {
                        String type = cmdDoc.getString("type");
                        String cmdId = cmdDoc.getId();
                        if ("install_app".equals(type)) {
                            if (Boolean.TRUE.equals(cmdDoc.getBoolean("cancelled"))) {
                                continue;
                            }
                            String appId = cmdDoc.getString("app_id");
                            String pkg = cmdDoc.getString("package_name");
                            String url = cmdDoc.getString("download_url");
                            String storagePath = cmdDoc.getString("storage_path");
                            long ver = cmdDoc.getLong("version_code") != null ? cmdDoc.getLong("version_code") : 1L;
                            String shaApk = cmdDoc.getString("sha256_apk");
                            String shaCert = cmdDoc.getString("sha256_cert");
                            boolean addToKiosk = cmdDoc.getBoolean("add_to_kiosk") != null ? cmdDoc.getBoolean("add_to_kiosk") : false;
                            String expiresAtStr = cmdDoc.getString("expires_at");
                            long expiresAtMs = 0L;
                            if (expiresAtStr != null && !expiresAtStr.isEmpty()) {
                                try {
                                    expiresAtMs = java.time.Instant.parse(expiresAtStr).toEpochMilli();
                                } catch (Exception ignored) {}
                            }

                            if (expiresAtMs > 0 && System.currentTimeMillis() > expiresAtMs) {
                                db.collection("deviceCommands").document(uid).collection("commands").document(cmdId)
                                        .update("status", "failed", "completed_at", FieldValue.serverTimestamp(),
                                                "error", "انتهت صلاحية أمر التثبيت (24 ساعة)");
                                continue;
                            }

                            // Mark started
                            db.collection("deviceCommands").document(uid).collection("commands").document(cmdId)
                                    .update("status", "in_progress", "started_at", FieldValue.serverTimestamp());

                            boolean hasDownloadSource = (storagePath != null && !storagePath.trim().isEmpty())
                                    || (url != null && !url.trim().isEmpty());
                            if (pkg != null && hasDownloadSource && shaApk != null) {
                                PackageInstallManager.downloadAndInstall(context, url, storagePath, appId, pkg, (int) ver, shaApk, shaCert, cmdId, uid, expiresAtMs, addToKiosk, new PackageInstallManager.InstallCallback() {
                                    @Override
                                    public void onProgress(String status) {
                                        db.collection("deviceCommands").document(uid).collection("commands").document(cmdId)
                                                .update("progress", status);
                                    }
                                    @Override
                                    public void onSuccess(String packageName, int versionCode) {}
                                    @Override
                                    public void onFailure(String err) {
                                        db.collection("deviceCommands").document(uid).collection("commands").document(cmdId)
                                                .update("status", "failed", "completed_at", FieldValue.serverTimestamp(), "error", err);
                                    }
                                });
                            }
                        } else if ("refresh_location".equals(type)) {
                            PolicyLocationService.startIfPolicyEnabled(context);
                            db.collection("deviceCommands").document(uid).collection("commands").document(cmdId)
                                    .update("status", "executed", "completed_at", FieldValue.serverTimestamp());
                        }
                    }
                }
            } catch (Exception ex) {
                Log.w(TAG, "device_commands_sync_failed: " + ex.getMessage());
            }
        }

        Map<String, Object> state = new HashMap<>();
        state.put("device_owner", owner);
        state.put("device_owner_protected", owner);
        state.put("deprovisioned", DeprovisionController.isDeprovisioned(context));
        state.put("block_app_installs", AppInstallPolicy.getLocal(context).blockAppInstalls);
        boolean locPolicyEnabled = LocationPolicy.getLocal(context).enabled;
        state.put("location_policy_enabled", locPolicyEnabled);
        LocationManager lm = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        boolean locSwitch = isLocationSwitchEnabled(lm);
        state.put("location_switch_on", locSwitch);
        state.put("location_service_running", PolicyLocationService.isServiceRunning());
        state.put("applied_revision", applied);
        state.put("tethering_restricted", owner && dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_CONFIG_TETHERING));
        state.put("last_seen", FieldValue.serverTimestamp());
        state.put("model", Build.MANUFACTURER + " " + Build.MODEL);
        state.put("android_sdk", Build.VERSION.SDK_INT);
        BatteryManager battery = (BatteryManager) context.getSystemService(Context.BATTERY_SERVICE);
        state.put("battery_percent", battery != null ? battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) : 0);
        state.put("error", error.length() > 1000 ? error.substring(0, 1000) : error);
        String restoreErr = RestrictionManager.prefs(context).getString("restriction_restoration_error", null);
        state.put("restriction_restoration_error", restoreErr != null && !restoreErr.isEmpty() ? restoreErr.substring(0, Math.min(restoreErr.length(), 1000)) : null);
        state.put("agent_version", AGENT_VERSION);
        Tasks.await(db.collection("deviceStatus").document(uid).set(state), 25, TimeUnit.SECONDS);

        if (owner) {
            // Marks initial sync as already satisfied so starting/keeping the service never triggers a new sync loop
            PolicySyncService.ensureStartedAfterVerifiedSync(context, "sync_verified_" + safeTrigger);
        } else {
            PolicySyncService.stopIfRunning(context, "device_owner_not_active");
        }

        COORDINATOR.setLastStatusMessage(result);
        if (!error.isEmpty()) {
            throw policyFailure;
        }
        Log.i(TAG, "sync_completed_ok: trigger=" + safeTrigger + " appliedRevision=" + applied
                + " elapsedMs=" + (SystemClock.elapsedRealtime() - startedAt));
        return result;
    }
}

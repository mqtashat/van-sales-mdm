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
import com.google.firebase.firestore.FirebaseFirestore;
import com.google.firebase.firestore.Source;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;

final class SyncEngine {
    static final String TAG = "InjazMdmAgent";
    static final String AGENT_VERSION = "0.3.1-pilot";
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
                Policy policy = Policy.parse(snapshot.getData(), applied);
                if (!owner) {
                    throw new IllegalStateException("Device Owner غير مفعّل؛ لم تطبّق السياسة.");
                }
                AppRestrictions.apply(context, dpm, admin, policy.blockedApps, prefs);
                if (policy.blockTethering) {
                    dpm.addUserRestriction(admin, UserManager.DISALLOW_CONFIG_TETHERING);
                } else {
                    dpm.clearUserRestriction(admin, UserManager.DISALLOW_CONFIG_TETHERING);
                }
                boolean actual = dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_CONFIG_TETHERING);
                if (actual != policy.blockTethering) {
                    throw new IllegalStateException("تعذر التحقق من تطبيق القيد.");
                }
                applied = policy.revision;
                prefs.edit().putLong(KEY_REVISION, applied).apply();
                result = actual
                        ? "تم التحقق: مشاركة الإنترنت ممنوعة."
                        : "تم التحقق: أزيل منع المشاركة الخاص بتطبيقنا.";
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

        Map<String, Object> state = new HashMap<>();
        state.put("device_owner", owner);
        state.put("applied_revision", applied);
        state.put("tethering_restricted", owner && dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_CONFIG_TETHERING));
        state.put("last_seen", FieldValue.serverTimestamp());
        state.put("model", Build.MANUFACTURER + " " + Build.MODEL);
        state.put("android_sdk", Build.VERSION.SDK_INT);
        BatteryManager battery = (BatteryManager) context.getSystemService(Context.BATTERY_SERVICE);
        state.put("battery_percent", battery != null ? battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) : 0);
        state.put("error", error.length() > 1000 ? error.substring(0, 1000) : error);
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


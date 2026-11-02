package com.company.mdmagent;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.app.admin.DevicePolicyManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseUser;
import com.google.firebase.firestore.FirebaseFirestore;
import com.google.firebase.firestore.FirebaseFirestoreException;
import com.google.firebase.firestore.ListenerRegistration;

/**
 * Foreground service keeping policy sync responsive in the background on Device Owner devices.
 *
 * Key invariants:
 * 1. Starting the service is idempotent (STOPPED / STARTING / RUNNING / STOPPING) and decoupled from sync loops.
 * 2. Strictly requires Device Owner (isDeviceOwnerApp) + authenticated Firebase UID + server-verified approval.
 * 3. Never applies policies directly from listener snapshots or cache; always delegates to SyncEngine.
 */
public class PolicySyncService extends Service {
    static final String TAG = "InjazMdmAgent";
    static final String CHANNEL_ID = "mdm_device_management";
    static final String NOTIFICATION_TITLE = "إدارة جهاز الشركة نشطة";
    static final int NOTIFICATION_ID = 1001;

    static final String ACTION_START_OR_VERIFY = "com.company.mdmagent.action.START_OR_VERIFY";
    static final String ACTION_STOP = "com.company.mdmagent.action.STOP";
    static final String EXTRA_TRIGGER = "trigger";

    enum LifecycleState {
        STOPPED,
        STARTING,
        RUNNING,
        STOPPING
    }

    interface ListenerHandle {
        void remove();
    }

    interface ListenerFactory {
        ListenerHandle attachEnrollmentListener(String uid);
        ListenerHandle attachPolicyListener(String uid);
    }

    interface AuthStateCallback {
        void onAuthStateChanged(String currentUid);
    }

    interface AuthStateRegistrar {
        ListenerHandle register(AuthStateCallback callback);
    }

    static final class StartCommandPlan {
        final boolean shouldStop;
        final boolean promoteBeforeStop;
        final String uid;
        final boolean triggerInitialSync;

        private StartCommandPlan(boolean shouldStop, boolean promoteBeforeStop, String uid, boolean triggerInitialSync) {
            this.shouldStop = shouldStop;
            this.promoteBeforeStop = promoteBeforeStop;
            this.uid = uid;
            this.triggerInitialSync = triggerInitialSync;
        }

        static StartCommandPlan stopImmediately(boolean promoteBeforeStop) {
            return new StartCommandPlan(true, promoteBeforeStop, null, false);
        }

        static StartCommandPlan run(String uid, boolean triggerInitialSync) {
            return new StartCommandPlan(false, false, uid, triggerInitialSync);
        }
    }

    /**
     * Thread-safe state machine controlling service start idempotency, listener deduplication,
     * and bounded initial sync without self-triggering loops.
     */
    static final class ServiceSessionController {
        private LifecycleState state = LifecycleState.STOPPED;
        private String activeUid = null;
        private String listenerUid = null;
        private ListenerHandle enrollmentHandle = null;
        private ListenerHandle policyHandle = null;
        private boolean enrollmentInitialSnapshotSeen = false;
        private boolean policyInitialSnapshotSeen = false;
        private String initialSyncSatisfiedUid = null;
        private boolean restartAfterStop = false;
        private String restartTrigger = null;

        synchronized LifecycleState getState() {
            return state;
        }

        synchronized boolean isRunning() {
            return state == LifecycleState.RUNNING;
        }

        synchronized boolean hasActiveListenersFor(String uid) {
            return uid != null
                    && uid.equals(listenerUid)
                    && enrollmentHandle != null
                    && policyHandle != null;
        }

        /**
         * Idempotent check to decide whether startForegroundService should be invoked.
         * When called for an already STARTING or healthy RUNNING service for the same UID,
         * returns false so no duplicate startForegroundService or sync is triggered.
         */
        synchronized boolean requestEnsureStarted(
                boolean eligible,
                String uid,
                String trigger,
                boolean syncAlreadyVerified
        ) {
            if (!eligible || uid == null || uid.trim().isEmpty()) {
                return false;
            }
            if (syncAlreadyVerified) {
                initialSyncSatisfiedUid = uid;
            }
            if (state == LifecycleState.RUNNING && uid.equals(activeUid) && hasActiveListenersFor(uid)) {
                return false;
            }
            if (state == LifecycleState.STARTING && uid.equals(activeUid)) {
                return false;
            }
            if (state == LifecycleState.STOPPING) {
                restartAfterStop = true;
                restartTrigger = trigger;
                activeUid = uid;
                return false;
            }
            state = LifecycleState.STARTING;
            activeUid = uid;
            return true;
        }

        synchronized StartCommandPlan onStartCommand(
                boolean isDeviceOwner,
                boolean fullEligible,
                String uid,
                boolean isStopAction
        ) {
            if (isStopAction || !isDeviceOwner || !fullEligible || uid == null || uid.trim().isEmpty()) {
                restartAfterStop = false;
                restartTrigger = null;
                state = LifecycleState.STOPPING;
                detachListenersInternal();
                return StartCommandPlan.stopImmediately(isDeviceOwner);
            }
            state = LifecycleState.RUNNING;
            activeUid = uid;
            boolean triggerInitialSync = !uid.equals(initialSyncSatisfiedUid);
            if (triggerInitialSync) {
                initialSyncSatisfiedUid = uid;
            }
            return StartCommandPlan.run(uid, triggerInitialSync);
        }

        /**
         * Attaches enrollment and policy listeners for uid if not already attached.
         * Never attaches duplicate listeners for the same uid; cleans up old listeners on uid change.
         */
        synchronized boolean attachListenersIfNeeded(String uid, ListenerFactory factory) {
            if (state != LifecycleState.RUNNING && state != LifecycleState.STARTING) {
                return false;
            }
            if (uid == null || uid.trim().isEmpty()) {
                detachListenersInternal();
                return false;
            }
            if (hasActiveListenersFor(uid)) {
                return false;
            }
            detachListenersInternal();
            listenerUid = uid;
            enrollmentInitialSnapshotSeen = false;
            policyInitialSnapshotSeen = false;
            enrollmentHandle = factory.attachEnrollmentListener(uid);
            policyHandle = factory.attachPolicyListener(uid);
            return true;
        }

        /**
         * Evaluates whether an enrollment listener snapshot should trigger a server sync.
         * Suppresses the initial snapshot when enrollment is already approved and initial sync is
         * already satisfied/scheduled, avoiding redundant syncs upon listener registration.
         */
        synchronized boolean onEnrollmentSnapshot(String uid, boolean fromCache, boolean approvedNow) {
            if (state != LifecycleState.RUNNING || fromCache || uid == null || !uid.equals(listenerUid)) {
                return false;
            }
            if (!enrollmentInitialSnapshotSeen) {
                enrollmentInitialSnapshotSeen = true;
                // If approval was revoked on the server before listener attached, must sync immediately.
                // If still approved, initial sync is already handled by onStartCommand or verified sync.
                return !approvedNow;
            }
            return true;
        }

        /**
         * Evaluates whether a policy listener snapshot should trigger a server sync.
         * Suppresses the initial snapshot upon listener registration when its revision already
         * matches the applied revision (or when the initial sync for this session is already running),
         * while immediately syncing if the server revision differs or on any subsequent change.
         */
        synchronized boolean onPolicySnapshot(
                String uid,
                boolean fromCache,
                boolean snapshotExists,
                Long snapshotRevision,
                long appliedRevision
        ) {
            if (state != LifecycleState.RUNNING || fromCache || uid == null || !uid.equals(listenerUid)) {
                return false;
            }
            if (!policyInitialSnapshotSeen) {
                policyInitialSnapshotSeen = true;
                if (!uid.equals(initialSyncSatisfiedUid)) {
                    return true;
                }
                boolean matchesApplied = (!snapshotExists && appliedRevision == 0L)
                        || (snapshotExists && snapshotRevision != null && snapshotRevision == appliedRevision);
                return !matchesApplied;
            }
            return true;
        }

        synchronized void detachListeners() {
            detachListenersInternal();
        }

        private void detachListenersInternal() {
            if (enrollmentHandle != null) {
                enrollmentHandle.remove();
                enrollmentHandle = null;
            }
            if (policyHandle != null) {
                policyHandle.remove();
                policyHandle = null;
            }
            listenerUid = null;
            enrollmentInitialSnapshotSeen = false;
            policyInitialSnapshotSeen = false;
        }

        synchronized boolean markStopping() {
            restartAfterStop = false;
            restartTrigger = null;
            if (state == LifecycleState.STOPPED || state == LifecycleState.STOPPING) {
                detachListenersInternal();
                return false;
            }
            state = LifecycleState.STOPPING;
            detachListenersInternal();
            return true;
        }

        synchronized String onDestroyed() {
            detachListenersInternal();
            state = LifecycleState.STOPPED;
            activeUid = null;
            initialSyncSatisfiedUid = null;
            if (restartAfterStop) {
                String trigger = restartTrigger != null ? restartTrigger : "restart_after_stop";
                restartAfterStop = false;
                restartTrigger = null;
                return trigger;
            }
            return null;
        }
    }

    private static final AuthStateRegistrar DEFAULT_AUTH_REGISTRAR = callback -> {
        FirebaseAuth auth = FirebaseAuth.getInstance();
        FirebaseAuth.AuthStateListener listener = firebaseAuth -> {
            FirebaseUser user = firebaseAuth.getCurrentUser();
            callback.onAuthStateChanged(user != null ? user.getUid() : null);
        };
        auth.addAuthStateListener(listener);
        return () -> auth.removeAuthStateListener(listener);
    };

    static final ServiceSessionController SESSION = new ServiceSessionController();
    private static volatile ListenerFactory listenerFactoryOverrideForTest;
    private static volatile AuthStateRegistrar authRegistrarOverrideForTest;

    static void setListenerFactoryOverrideForTest(ListenerFactory factory) {
        listenerFactoryOverrideForTest = factory;
    }

    static void setAuthRegistrarOverrideForTest(AuthStateRegistrar registrar) {
        authRegistrarOverrideForTest = registrar;
    }

    static boolean onEnrollmentSnapshotReceived(Context context, String targetUid, boolean fromCache, boolean approvedNow) {
        if (!SESSION.isRunning()) return false;
        if (!SESSION.onEnrollmentSnapshot(targetUid, fromCache, approvedNow)) {
            return false;
        }
        Log.i(TAG, "fgs_enrollment_snapshot_server: approved=" + approvedNow);
        if (context != null) {
            SyncEngine.requestSync(context.getApplicationContext(), "fgs_enrollment_snapshot");
        }
        return true;
    }

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private ConnectivityManager.NetworkCallback networkCallback;
    private ListenerHandle authListenerHandle;
    private final NetworkRecoveryState networkRecovery = new NetworkRecoveryState();

    static boolean isRunning() {
        return SESSION.isRunning();
    }

    /**
     * Strictly requires Device Owner matching SyncEngine enforcement (Profile Owner is not supported).
     */
    static boolean isDeviceOwnerActive(Context context) {
        if (context == null) return false;
        DevicePolicyManager dpm = (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm == null) return false;
        return dpm.isDeviceOwnerApp(context.getPackageName());
    }

    /**
     * Unified eligibility check delegating directly to SyncEngine.canStartServiceForState.
     */
    static boolean canRunForegroundService(Context context) {
        if (context == null) return false;
        boolean isOwner = isDeviceOwnerActive(context);
        String currentUid = SyncEngine.getCurrentAuthenticatedUid();
        SharedPreferences prefs = context.getSharedPreferences(SyncEngine.PREFS_NAME, Context.MODE_PRIVATE);
        boolean approvedVerified = prefs.getBoolean(SyncEngine.KEY_APPROVED_VERIFIED, false);
        String approvedUid = prefs.getString(SyncEngine.KEY_APPROVED_UID, "");
        return SyncEngine.canStartServiceForState(isOwner, currentUid, approvedVerified, approvedUid);
    }

    /**
     * Pure notification visibility check testable in JUnit without Android framework mocks.
     * Note: Notification permission is never a prerequisite to run the Foreground Service,
     * but determines whether the ongoing notification is visibly shown to the user.
     */
    static boolean isNotificationPermitted(int sdkInt, boolean runtimePermissionGranted, boolean appNotificationsEnabled) {
        if (!appNotificationsEnabled) return false;
        if (sdkInt >= Build.VERSION_CODES.TIRAMISU) {
            return runtimePermissionGranted;
        }
        return true;
    }

    static boolean isNotificationVisible(Context context) {
        if (context == null) return false;
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        boolean appNotificationsEnabled = nm != null && nm.areNotificationsEnabled();
        boolean runtimeGranted = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            runtimeGranted = context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    == PackageManager.PERMISSION_GRANTED;
        }
        NotificationChannel channel = nm != null ? nm.getNotificationChannel(CHANNEL_ID) : null;
        return isNotificationPermitted(Build.VERSION.SDK_INT, runtimeGranted, appNotificationsEnabled)
                && channel != null && channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    static String describeEligibility(Context context) {
        boolean owner = isDeviceOwnerActive(context);
        String uid = SyncEngine.getCurrentAuthenticatedUid();
        boolean hasUser = uid != null && !uid.isEmpty();
        boolean approved = hasUser && SyncEngine.isDeviceApproved(context, uid);
        return "deviceOwner=" + owner + ", firebaseUser=" + hasUser + ", approved=" + approved
                + ", state=" + SESSION.getState();
    }

    /**
     * Ensures the foreground service is running. Idempotent: if the service is already
     * STARTING or RUNNING with active listeners for the current UID, this is a no-op
     * and does NOT re-invoke startForegroundService or trigger a new sync.
     */
    static void ensureStarted(Context context, String trigger) {
        ensureStartedInternal(context, trigger, false);
    }

    /**
     * Called by SyncEngine after a server sync has already verified enrollment and policy.
     * Marks initial sync as satisfied so starting the service will NOT trigger a second sync loop.
     */
    static void ensureStartedAfterVerifiedSync(Context context, String trigger) {
        ensureStartedInternal(context, trigger, true);
    }

    private static void ensureStartedInternal(Context context, String trigger, boolean syncAlreadyVerified) {
        if (context == null) return;
        Context appContext = context.getApplicationContext();
        boolean eligible = canRunForegroundService(appContext);
        String uid = SyncEngine.getCurrentAuthenticatedUid();

        if (!SESSION.requestEnsureStarted(eligible, uid, trigger, syncAlreadyVerified)) {
            if (!eligible) {
                Log.i(TAG, "fgs_ensure_skipped_ineligible: trigger=" + trigger + " (" + describeEligibility(appContext) + ")");
            }
            return;
        }

        Intent intent = new Intent(appContext, PolicySyncService.class)
                .setAction(ACTION_START_OR_VERIFY)
                .putExtra(EXTRA_TRIGGER, trigger);
        try {
            appContext.startForegroundService(intent);
            Log.i(TAG, "fgs_start_requested: trigger=" + trigger + " syncAlreadyVerified=" + syncAlreadyVerified);
        } catch (RuntimeException ex) {
            SESSION.onDestroyed();
            Log.w(TAG, "fgs_start_rejected_by_os: trigger=" + trigger
                    + " type=" + ex.getClass().getSimpleName()
                    + " message=" + String.valueOf(ex.getMessage()));
        }
    }

    /**
     * Stops the foreground service cleanly if it is starting or running.
     */
    static void stopIfRunning(Context context, String reason) {
        if (context == null) return;
        if (!SESSION.markStopping()) {
            return;
        }
        Context appContext = context.getApplicationContext();
        Log.i(TAG, "fgs_stop_requested: reason=" + reason);
        try {
            appContext.stopService(new Intent(appContext, PolicySyncService.class));
        } catch (RuntimeException ex) {
            SESSION.onDestroyed();
            Log.w(TAG, "fgs_stop_failed: reason=" + reason + " error=" + ex.getClass().getSimpleName());
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        ensureNotificationChannel();
        registerAuthListener();
        registerNetworkCallback();
        Log.i(TAG, "fgs_created: sdk=" + Build.VERSION.SDK_INT);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        String trigger = intent != null && intent.getStringExtra(EXTRA_TRIGGER) != null
                ? intent.getStringExtra(EXTRA_TRIGGER)
                : (action != null ? action : "system_restart");

        boolean isStopAction = ACTION_STOP.equals(action);
        boolean isOwner = isDeviceOwnerActive(this);
        boolean fullEligible = canRunForegroundService(this);
        String uid = SyncEngine.getCurrentAuthenticatedUid();

        StartCommandPlan plan = SESSION.onStartCommand(isOwner, fullEligible, uid, isStopAction);
        if (plan.shouldStop) {
            Log.w(TAG, "fgs_onStartCommand_stopping: trigger=" + trigger + " (" + describeEligibility(this) + ")");
            if (plan.promoteBeforeStop) {
                promoteToForeground("جارٍ إيقاف خدمة الإدارة…");
            }
            stopForegroundAndSelf("ineligible_or_stop_action");
            return START_NOT_STICKY;
        }

        if (!promoteToForeground("متصل بخدمة سياسات الشركة ومزامنة القيود بالخلفية")) {
            return START_NOT_STICKY;
        }

        attachListenersOnMainThread(plan.uid);

        if (plan.triggerInitialSync) {
            Log.i(TAG, "fgs_initial_sync_requested: trigger=" + trigger);
            SyncEngine.requestSync(getApplicationContext(), "fgs_initial_" + trigger);
        } else {
            Log.i(TAG, "fgs_active_without_redundant_sync: trigger=" + trigger);
        }
        return START_STICKY;
    }

    private boolean promoteToForeground(String contentText) {
        Notification notification = buildNotification(contentText);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(
                        NOTIFICATION_ID,
                        notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED
                );
                Log.i(TAG, "fgs_promoted: type=systemExempted sdk=" + Build.VERSION.SDK_INT
                        + " notifVisible=" + isNotificationVisible(this));
            } else {
                startForeground(NOTIFICATION_ID, notification);
                Log.i(TAG, "fgs_promoted: type=legacy sdk=" + Build.VERSION.SDK_INT
                        + " notifVisible=" + isNotificationVisible(this));
            }
            return true;
        } catch (RuntimeException ex) {
            Log.e(TAG, "fgs_promote_failed: sdk=" + Build.VERSION.SDK_INT
                    + " type=" + ex.getClass().getSimpleName()
                    + " message=" + String.valueOf(ex.getMessage()));
            stopForegroundAndSelf("promote_exception");
            return false;
        }
    }

    private void ensureNotificationChannel() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "إدارة جهاز الشركة",
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("إشعار خدمة إدارة جهاز الشركة ومزامنة القيود المعتمدة");
        channel.setShowBadge(false);
        nm.createNotificationChannel(channel);
    }

    private Notification buildNotification(String contentText) {
        Intent openIntent = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this,
                0,
                openIntent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        return new Notification.Builder(this, CHANNEL_ID)
                .setContentTitle(NOTIFICATION_TITLE)
                .setContentText(contentText)
                .setSmallIcon(android.R.drawable.ic_lock_lock)
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .setContentIntent(pendingIntent)
                .build();
    }

    private void attachListenersOnMainThread(String uid) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            attachListenersInternal(uid);
        } else {
            mainHandler.post(() -> attachListenersInternal(uid));
        }
    }

    private void attachListenersInternal(String uid) {
        ListenerFactory override = listenerFactoryOverrideForTest;
        ListenerFactory factory = override != null ? override : new ListenerFactory() {
            private final FirebaseFirestore db = FirebaseFirestore.getInstance();

            @Override
            public ListenerHandle attachEnrollmentListener(String targetUid) {
                final ListenerRegistration reg = db.collection("enrollments").document(targetUid)
                        .addSnapshotListener((snapshot, error) -> {
                            if (!SESSION.isRunning()) return;
                            if (error != null) {
                                FirebaseFirestoreException.Code code = error.getCode();
                                Log.w(TAG, "fgs_enrollment_listener_error: code=" + code);
                                if (code == FirebaseFirestoreException.Code.PERMISSION_DENIED) {
                                    SyncEngine.requestSync(getApplicationContext(), "fgs_enrollment_perm_denied");
                                }
                                return;
                            }
                            if (snapshot == null) {
                                return;
                            }
                            boolean fromCache = snapshot.getMetadata().isFromCache();
                            boolean approvedNow = snapshot.exists() && Boolean.TRUE.equals(snapshot.getBoolean("approved"));
                            onEnrollmentSnapshotReceived(getApplicationContext(), targetUid, fromCache, approvedNow);
                        });
                return reg::remove;
            }

            @Override
            public ListenerHandle attachPolicyListener(String targetUid) {
                final ListenerRegistration reg = db.collection("policies").document(targetUid)
                        .addSnapshotListener((snapshot, error) -> {
                            if (!SESSION.isRunning()) return;
                            if (error != null) {
                                FirebaseFirestoreException.Code code = error.getCode();
                                Log.w(TAG, "fgs_policy_listener_error: code=" + code);
                                if (code == FirebaseFirestoreException.Code.PERMISSION_DENIED) {
                                    SyncEngine.requestSync(getApplicationContext(), "fgs_policy_perm_denied");
                                }
                                return;
                            }
                            if (snapshot == null) {
                                return;
                            }
                            boolean fromCache = snapshot.getMetadata().isFromCache();
                            boolean exists = snapshot.exists();
                            Long snapshotRev = (exists && snapshot.get("revision") instanceof Long)
                                    ? snapshot.getLong("revision")
                                    : null;
                            long appliedRev = getSharedPreferences(SyncEngine.PREFS_NAME, Context.MODE_PRIVATE)
                                    .getLong(SyncEngine.KEY_REVISION, 0);
                            if (!SESSION.onPolicySnapshot(targetUid, fromCache, exists, snapshotRev, appliedRev)) {
                                return;
                            }
                            // Never apply policy data directly from snapshot or cache; trigger SyncEngine server verification
                            Log.i(TAG, "fgs_policy_snapshot_server: triggering SyncEngine verification");
                            SyncEngine.requestSync(getApplicationContext(), "fgs_policy_snapshot");
                        });
                return reg::remove;
            }
        };
        boolean attachedNew = SESSION.attachListenersIfNeeded(uid, factory);
        if (attachedNew) {
            Log.i(TAG, "fgs_listeners_attached");
        }
    }

    private void registerAuthListener() {
        AuthStateRegistrar registrar = authRegistrarOverrideForTest != null
                ? authRegistrarOverrideForTest
                : DEFAULT_AUTH_REGISTRAR;
        authListenerHandle = registrar.register(currentUid -> {
            if (!SESSION.isRunning()) return;
            if (currentUid == null || currentUid.isEmpty()) {
                Log.w(TAG, "fgs_auth_state_signed_out: stopping service");
                stopForegroundAndSelf("auth_signed_out");
            } else if (!SESSION.hasActiveListenersFor(currentUid)) {
                Log.i(TAG, "fgs_auth_state_uid_changed: re-evaluating eligibility");
                if (canRunForegroundService(PolicySyncService.this)) {
                    attachListenersOnMainThread(currentUid);
                    SyncEngine.requestSync(getApplicationContext(), "fgs_auth_uid_changed");
                } else {
                    stopForegroundAndSelf("auth_uid_not_approved");
                }
            }
        });
    }

    private void registerNetworkCallback() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                networkRecovery.available(network);
                Log.i(TAG, "fgs_network_available: waiting for validation");
            }

            @Override
            public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) {
                boolean validated = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                        && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
                boolean recovered = networkRecovery.capabilities(network, validated);
                Log.i(TAG, "fgs_network_capabilities: validated=" + validated + " recovered=" + recovered);
                if (recovered && SESSION.isRunning()) {
                    // Includes initial validation, WAN restoration and default-network handover.
                    // Repeated validated callbacks do not create a sync loop.
                    SyncEngine.requestSync(getApplicationContext(), "fgs_network_validated");
                }
            }

            @Override
            public void onLost(Network network) {
                networkRecovery.lost(network);
                Log.i(TAG, "fgs_network_lost: keeping applied restrictions enforced offline");
            }
        };
        try {
            cm.registerDefaultNetworkCallback(networkCallback);
        } catch (RuntimeException ex) {
            Log.w(TAG, "fgs_network_callback_register_failed: " + ex.getClass().getSimpleName());
            networkCallback = null;
        }
    }

    private void stopForegroundAndSelf(String reason) {
        SESSION.markStopping();
        try {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } catch (RuntimeException ignored) {
        }
        stopSelf();
        Log.i(TAG, "fgs_stopped_self: reason=" + reason);
    }

    @Override
    public void onDestroy() {
        if (authListenerHandle != null) {
            authListenerHandle.remove();
            authListenerHandle = null;
        }
        if (networkCallback != null) {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) {
                try {
                    cm.unregisterNetworkCallback(networkCallback);
                } catch (RuntimeException ignored) {
                }
            }
            networkCallback = null;
        }
        String restartTrigger = SESSION.onDestroyed();
        Log.i(TAG, "fgs_destroyed");
        if (restartTrigger != null && canRunForegroundService(getApplicationContext())) {
            ensureStarted(getApplicationContext(), restartTrigger);
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}


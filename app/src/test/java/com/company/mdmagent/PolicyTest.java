package com.company.mdmagent;

import android.Manifest;
import android.app.Application;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.UserManager;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ServiceController;
import org.robolectric.annotation.Config;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 34)
public class PolicyTest {
    private Map<String, Object> policy(long revision, boolean block) {
        Map<String, Object> p = new HashMap<>();
        p.put("schema_version", 1L);
        p.put("revision", revision);
        p.put("block_tethering", block);
        p.put("blocked_apps", List.of());
        return p;
    }

    @Test
    public void canBlockAndExplicitlyUnblockWithNewRevision() {
        assertTrue(Policy.parse(policy(1, true), 0).blockTethering);
        assertFalse(Policy.parse(policy(2, false), 1).blockTethering);
    }

    @Test
    public void missingAndMistypedValuesNeverSilentlyUnlock() {
        Map<String, Object> p = policy(1, true);
        p.remove("block_tethering");
        assertThrows(IllegalArgumentException.class, () -> Policy.parse(p, 0));
        p.put("block_tethering", "false");
        assertThrows(IllegalArgumentException.class, () -> Policy.parse(p, 0));
        assertThrows(IllegalArgumentException.class, () -> Policy.parse(null, 0));
    }

    @Test
    public void rejectsStalePolicyButAllowsIdempotentReplay() {
        assertThrows(IllegalArgumentException.class, () -> Policy.parse(policy(1, false), 2));
        assertTrue(Policy.parse(policy(2, true), 2).blockTethering);
    }

    @Test
    public void rejectsInvalidSchemaAndNonIntegerRevision() {
        Map<String, Object> p = policy(1, true);
        p.put("schema_version", 2L);
        assertThrows(IllegalArgumentException.class, () -> Policy.parse(p, 0));
        p.put("schema_version", 1L);
        p.put("revision", 1.5);
        assertThrows(IllegalArgumentException.class, () -> Policy.parse(p, 0));
    }

    @Test
    public void appListMustBeExplicitAndWellFormed() {
        Map<String, Object> p = policy(1, true);
        p.remove("blocked_apps");
        assertThrows(IllegalArgumentException.class, () -> Policy.parse(p, 0));
        p.put("blocked_apps", List.of("com.example.game"));
        assertTrue(Policy.parse(p, 0).blockedApps.contains("com.example.game"));
        p.put("blocked_apps", List.of("not a package"));
        assertThrows(IllegalArgumentException.class, () -> Policy.parse(p, 0));
    }

    @Test
    public void foregroundServiceEligibilityRequiresDeviceOwnerUserAndMatchingApproval() {
        assertTrue(SyncEngine.canStartServiceForState(true, "deviceUid1", true, "deviceUid1"));
        assertFalse(SyncEngine.canStartServiceForState(false, "deviceUid1", true, "deviceUid1"));
        assertFalse(SyncEngine.canStartServiceForState(true, null, true, "deviceUid1"));
        assertFalse(SyncEngine.canStartServiceForState(true, "", true, ""));
        assertFalse(SyncEngine.canStartServiceForState(true, "deviceUid1", false, "deviceUid1"));
        assertFalse(SyncEngine.canStartServiceForState(true, "deviceUid2", true, "deviceUid1"));
    }

    @Test
    @Config(sdk = 34)
    public void notificationVisibilityChecksSystemPermissionAppSettingAndServiceChannelOnApi34() {
        Application app = RuntimeEnvironment.getApplication();
        NotificationManager nm = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
        assertNotNull(nm);

        // 1. Grant runtime permission and enable app notifications, but channel is not created yet -> false
        Shadows.shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS);
        Shadows.shadowOf(nm).setNotificationsEnabled(true);
        nm.deleteNotificationChannel(PolicySyncService.CHANNEL_ID);
        assertFalse(PolicySyncService.isNotificationVisible(app));

        // 2. Create the service notification channel with IMPORTANCE_LOW -> all 3 conditions met -> true
        NotificationChannel activeChannel = new NotificationChannel(
                PolicySyncService.CHANNEL_ID,
                "إدارة جهاز الشركة",
                NotificationManager.IMPORTANCE_LOW
        );
        nm.createNotificationChannel(activeChannel);
        assertTrue(PolicySyncService.isNotificationVisible(app));

        // 3. Disable app-wide notifications while the channel remains enabled.
        Shadows.shadowOf(nm).setNotificationsEnabled(false);
        assertFalse(PolicySyncService.isNotificationVisible(app));
        Shadows.shadowOf(nm).setNotificationsEnabled(true);
        assertTrue(PolicySyncService.isNotificationVisible(app));

        // 4. Deny and restore runtime permission independently of channel settings.
        Shadows.shadowOf(app).denyPermissions(Manifest.permission.POST_NOTIFICATIONS);
        assertFalse(PolicySyncService.isNotificationVisible(app));
        Shadows.shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS);
        assertTrue(PolicySyncService.isNotificationVisible(app));

        // 5. Lower channel importance last: recreating a channel cannot raise it again.
        NotificationChannel mutedChannel = new NotificationChannel(
                PolicySyncService.CHANNEL_ID,
                "إدارة جهاز الشركة",
                NotificationManager.IMPORTANCE_NONE
        );
        nm.createNotificationChannel(mutedChannel);
        assertFalse(PolicySyncService.isNotificationVisible(app));
    }

    @Test
    @Config(sdk = 31)
    public void notificationVisibilityChecksAppSettingAndServiceChannelOnApi31() {
        Application app = RuntimeEnvironment.getApplication();
        NotificationManager nm = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
        assertNotNull(nm);

        // On Android 12 (API 31), POST_NOTIFICATIONS runtime permission is not required,
        // but both app notification setting and service channel importance are still required.
        Shadows.shadowOf(app).denyPermissions(Manifest.permission.POST_NOTIFICATIONS);
        Shadows.shadowOf(nm).setNotificationsEnabled(true);
        nm.deleteNotificationChannel(PolicySyncService.CHANNEL_ID);
        assertFalse(PolicySyncService.isNotificationVisible(app));

        NotificationChannel activeChannel = new NotificationChannel(
                PolicySyncService.CHANNEL_ID,
                "إدارة جهاز الشركة",
                NotificationManager.IMPORTANCE_LOW
        );
        nm.createNotificationChannel(activeChannel);
        assertTrue(PolicySyncService.isNotificationVisible(app));

        Shadows.shadowOf(nm).setNotificationsEnabled(false);
        assertFalse(PolicySyncService.isNotificationVisible(app));
    }

    @Test
    public void syncStabilizesAfterServiceStartWithInitialFirestoreListenerEventsAndRepeatedStartCommand() {
        PolicySyncService.ServiceSessionController session = new PolicySyncService.ServiceSessionController();
        AtomicInteger startServiceCalls = new AtomicInteger(0);
        AtomicInteger executedSyncs = new AtomicInteger(0);
        AtomicLong appliedRevision = new AtomicLong(1L);
        AtomicLong serverPolicyRevision = new AtomicLong(1L);
        SyncEngine.QueueCoordinator[] coordinatorRef = new SyncEngine.QueueCoordinator[1];

        // Real-behavior listener factory: immediately delivers initial Firestore server snapshots upon attachment
        PolicySyncService.ListenerFactory factory = new PolicySyncService.ListenerFactory() {
            @Override
            public PolicySyncService.ListenerHandle attachEnrollmentListener(String uid) {
                if (session.onEnrollmentSnapshot(uid, false, true)) {
                    coordinatorRef[0].submit("fgs_enrollment_snapshot");
                }
                return () -> {};
            }

            @Override
            public PolicySyncService.ListenerHandle attachPolicyListener(String uid) {
                if (session.onPolicySnapshot(uid, false, true, serverPolicyRevision.get(), appliedRevision.get())) {
                    coordinatorRef[0].submit("fgs_policy_snapshot");
                }
                return () -> {};
            }
        };

        coordinatorRef[0] = new SyncEngine.QueueCoordinator(
                Runnable::run,
                trigger -> {
                    executedSyncs.incrementAndGet();
                    appliedRevision.set(serverPolicyRevision.get());
                    // Simulate SyncEngine.sync finishing and calling PolicySyncService.ensureStartedAfterVerifiedSync
                    boolean startAgain = session.requestEnsureStarted(true, "uid1", "sync_verified_" + trigger, true);
                    if (startAgain) {
                        startServiceCalls.incrementAndGet();
                        PolicySyncService.StartCommandPlan plan = session.onStartCommand(true, true, "uid1", false);
                        session.attachListenersIfNeeded("uid1", factory);
                        if (plan.triggerInitialSync) {
                            coordinatorRef[0].submit("fgs_initial_from_sync");
                        }
                    }
                    return "ok";
                },
                null
        );

        // Cold start of service (e.g., boot_completed)
        assertTrue(session.requestEnsureStarted(true, "uid1", "boot_completed", false));
        startServiceCalls.incrementAndGet();

        // Duplicate ensureStarted while STARTING is a no-op
        assertFalse(session.requestEnsureStarted(true, "uid1", "duplicate_boot", false));

        // Service enters onStartCommand, attaches listeners (which immediately emit initial server snapshots),
        // and triggers the single bounded initial sync
        PolicySyncService.StartCommandPlan plan = session.onStartCommand(true, true, "uid1", false);
        assertFalse(plan.shouldStop);
        assertTrue(plan.triggerInitialSync);
        assertTrue(session.attachListenersIfNeeded("uid1", factory));
        if (plan.triggerInitialSync) {
            coordinatorRef[0].submit("fgs_initial_boot_completed");
        }

        // Initial listener snapshots must NOT cause extra syncs; total syncs must be 1
        assertEquals(1, startServiceCalls.get());
        assertEquals(1, executedSyncs.get());
        assertTrue(session.isRunning());

        // Repeated onStartCommand redeliveries or ensureStarted calls must not attach duplicate listeners or sync
        PolicySyncService.StartCommandPlan redeliveredPlan = session.onStartCommand(true, true, "uid1", false);
        assertFalse(redeliveredPlan.shouldStop);
        assertFalse(redeliveredPlan.triggerInitialSync);
        assertFalse(session.attachListenersIfNeeded("uid1", factory));
        assertFalse(session.requestEnsureStarted(true, "uid1", "repeated_check", false));
        assertEquals(1, executedSyncs.get());

        // Subsequent server policy update (revision 2) triggers exactly 1 sync and stabilizes
        serverPolicyRevision.set(2L);
        assertTrue(session.onPolicySnapshot("uid1", false, true, 2L, appliedRevision.get()));
        coordinatorRef[0].submit("fgs_policy_snapshot");
        assertEquals(2, executedSyncs.get());
        assertEquals(2L, appliedRevision.get());
    }

    @Test
    public void completingSuccessfulSyncAndStartingServiceDoesNotGenerateFollowUpSyncFromInitialSnapshots() {
        PolicySyncService.ServiceSessionController session = new PolicySyncService.ServiceSessionController();
        AtomicInteger executedSyncs = new AtomicInteger(0);
        AtomicLong appliedRevision = new AtomicLong(0L);
        AtomicLong serverRevision = new AtomicLong(3L);
        SyncEngine.QueueCoordinator[] coordinatorRef = new SyncEngine.QueueCoordinator[1];

        PolicySyncService.ListenerFactory factory = new PolicySyncService.ListenerFactory() {
            @Override
            public PolicySyncService.ListenerHandle attachEnrollmentListener(String uid) {
                if (session.onEnrollmentSnapshot(uid, false, true)) {
                    coordinatorRef[0].submit("fgs_enrollment_snapshot");
                }
                return () -> {};
            }

            @Override
            public PolicySyncService.ListenerHandle attachPolicyListener(String uid) {
                if (session.onPolicySnapshot(uid, false, true, serverRevision.get(), appliedRevision.get())) {
                    coordinatorRef[0].submit("fgs_policy_snapshot");
                }
                return () -> {};
            }
        };

        coordinatorRef[0] = new SyncEngine.QueueCoordinator(
                Runnable::run,
                trigger -> {
                    executedSyncs.incrementAndGet();
                    appliedRevision.set(serverRevision.get());
                    // SyncEngine finishes and calls ensureStartedAfterVerifiedSync (syncAlreadyVerified = true)
                    boolean shouldStartService = session.requestEnsureStarted(true, "uid1", "sync_verified", true);
                    if (shouldStartService) {
                        PolicySyncService.StartCommandPlan plan = session.onStartCommand(true, true, "uid1", false);
                        session.attachListenersIfNeeded("uid1", factory);
                        if (plan.triggerInitialSync) {
                            coordinatorRef[0].submit("fgs_initial_from_sync");
                        }
                    }
                    return "تم التحقق";
                },
                null
        );

        // First manual sync applies revision 3 and starts the service for the first time;
        // initial Firestore listener snapshots fire with revision 3 == appliedRevision 3 and must not re-sync
        coordinatorRef[0].submit("ui_manual_button");
        assertEquals(1, executedSyncs.get());
        assertTrue(session.isRunning());
    }

    @Test
    public void initialPolicySnapshotWithNewerServerRevisionStillTriggersSync() {
        PolicySyncService.ServiceSessionController session = new PolicySyncService.ServiceSessionController();
        // Service started after a verified sync at revision 2, but server already advanced to revision 3
        // before the listener attached
        assertTrue(session.requestEnsureStarted(true, "uid1", "sync_verified", true));
        PolicySyncService.StartCommandPlan plan = session.onStartCommand(true, true, "uid1", false);
        assertFalse(plan.triggerInitialSync);

        AtomicInteger syncTriggered = new AtomicInteger(0);
        session.attachListenersIfNeeded("uid1", new PolicySyncService.ListenerFactory() {
            @Override
            public PolicySyncService.ListenerHandle attachEnrollmentListener(String uid) {
                if (session.onEnrollmentSnapshot(uid, false, true)) {
                    syncTriggered.incrementAndGet();
                }
                return () -> {};
            }

            @Override
            public PolicySyncService.ListenerHandle attachPolicyListener(String uid) {
                if (session.onPolicySnapshot(uid, false, true, 3L, 2L)) {
                    syncTriggered.incrementAndGet();
                }
                return () -> {};
            }
        });
        assertEquals(1, syncTriggered.get());
    }

    @Test
    public void syncRequestArrivingDuringQueueDrainCompletionIsNeverLost() throws Exception {
        ExecutorService workerThread = Executors.newSingleThreadExecutor();
        ExecutorService callerThread = Executors.newSingleThreadExecutor();
        try {
            CountDownLatch enteredCompletionSection = new CountDownLatch(1);
            CountDownLatch allowCompletionToProceed = new CountDownLatch(1);
            CountDownLatch bothFinished = new CountDownLatch(2);
            CountDownLatch secondSyncDrainedToIdle = new CountDownLatch(1);
            List<String> executedTriggers = Collections.synchronizedList(new ArrayList<>());
            AtomicReference<Thread> submitterThreadRef = new AtomicReference<>();

            SyncEngine.QueueCoordinator coordinator = new SyncEngine.QueueCoordinator(
                    workerThread::execute,
                    trigger -> {
                        executedTriggers.add(trigger);
                        bothFinished.countDown();
                        return "done:" + trigger;
                    },
                    (inProgress, message) -> {
                        if (!inProgress
                                && "done:second_sync_during_completion".equals(message)
                                && executedTriggers.contains("second_sync_during_completion")) {
                            secondSyncDrainedToIdle.countDown();
                        }
                    }
            );

            // Pause inside drain()'s completion critical section AFTER action.run("first_sync") has returned,
            // right before checking `pending` and resetting `running = false`.
            coordinator.setCompletionHookForTest(() -> {
                coordinator.setCompletionHookForTest(null);
                enteredCompletionSection.countDown();
                try {
                    assertTrue(allowCompletionToProceed.await(5, TimeUnit.SECONDS));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            });

            assertTrue(coordinator.submit("first_sync"));
            assertTrue(enteredCompletionSection.await(5, TimeUnit.SECONDS));

            // Submit a second request on another thread while drain() is in the completion section
            CountDownLatch submitStarted = new CountDownLatch(1);
            CountDownLatch submitReturned = new CountDownLatch(1);
            callerThread.execute(() -> {
                submitterThreadRef.set(Thread.currentThread());
                submitStarted.countDown();
                coordinator.submit("second_sync_during_completion");
                submitReturned.countDown();
            });

            assertTrue(submitStarted.await(5, TimeUnit.SECONDS));
            // Spin-yield until the caller thread contends on the unified lock inside submit()
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (System.nanoTime() < deadline) {
                Thread t = submitterThreadRef.get();
                if (t != null && t.getState() == Thread.State.BLOCKED) {
                    break;
                }
                Thread.yield();
            }
            assertNotNull(submitterThreadRef.get());
            assertEquals("submit() must block on the unified lock during drain completion",
                    Thread.State.BLOCKED, submitterThreadRef.get().getState());

            // Release drain() completion; wait explicitly for the second request's idle notification
            // and for the worker thread's Runnable to finish completely before checking isRunning().
            allowCompletionToProceed.countDown();
            assertTrue(submitReturned.await(5, TimeUnit.SECONDS));
            assertTrue(bothFinished.await(5, TimeUnit.SECONDS));
            assertTrue(secondSyncDrainedToIdle.await(5, TimeUnit.SECONDS));
            workerThread.submit(() -> {}).get(5, TimeUnit.SECONDS);
            assertEquals(List.of("first_sync", "second_sync_during_completion"), executedTriggers);
            assertFalse(coordinator.isRunning());
            assertEquals("done:second_sync_during_completion", coordinator.getLastStatusMessage());
        } finally {
            workerThread.shutdownNow();
            callerThread.shutdownNow();
        }
    }

    @Test
    public void listenersAreNotDuplicatedAndAreCleanedUpOnUidChangeOrStop() {
        PolicySyncService.ServiceSessionController session = new PolicySyncService.ServiceSessionController();
        AtomicInteger enrollmentAttachCount = new AtomicInteger(0);
        AtomicInteger enrollmentRemoveCount = new AtomicInteger(0);
        AtomicInteger policyAttachCount = new AtomicInteger(0);
        AtomicInteger policyRemoveCount = new AtomicInteger(0);

        PolicySyncService.ListenerFactory factory = new PolicySyncService.ListenerFactory() {
            @Override
            public PolicySyncService.ListenerHandle attachEnrollmentListener(String uid) {
                enrollmentAttachCount.incrementAndGet();
                return enrollmentRemoveCount::incrementAndGet;
            }

            @Override
            public PolicySyncService.ListenerHandle attachPolicyListener(String uid) {
                policyAttachCount.incrementAndGet();
                return policyRemoveCount::incrementAndGet;
            }
        };

        session.requestEnsureStarted(true, "uid1", "start", true);
        session.onStartCommand(true, true, "uid1", false);

        // Attach multiple times for the same UID
        assertTrue(session.attachListenersIfNeeded("uid1", factory));
        assertFalse(session.attachListenersIfNeeded("uid1", factory));
        assertFalse(session.attachListenersIfNeeded("uid1", factory));

        assertEquals(1, enrollmentAttachCount.get());
        assertEquals(1, policyAttachCount.get());
        assertEquals(0, enrollmentRemoveCount.get());
        assertEquals(0, policyRemoveCount.get());

        // Switching UID detaches previous listeners and attaches once for uid2
        assertTrue(session.attachListenersIfNeeded("uid2", factory));
        assertEquals(2, enrollmentAttachCount.get());
        assertEquals(2, policyAttachCount.get());
        assertEquals(1, enrollmentRemoveCount.get());
        assertEquals(1, policyRemoveCount.get());
    }

    @Test
    public void stoppingServiceDetachesListenersAndAllowsOneRestart() {
        PolicySyncService.ServiceSessionController session = new PolicySyncService.ServiceSessionController();
        AtomicInteger removed = new AtomicInteger();
        PolicySyncService.ListenerFactory factory = new PolicySyncService.ListenerFactory() {
            public PolicySyncService.ListenerHandle attachEnrollmentListener(String uid) { return removed::incrementAndGet; }
            public PolicySyncService.ListenerHandle attachPolicyListener(String uid) { return removed::incrementAndGet; }
        };
        assertTrue(session.requestEnsureStarted(true, "uid1", "start", true));
        session.onStartCommand(true, true, "uid1", false);
        session.attachListenersIfNeeded("uid1", factory);
        assertTrue(session.markStopping());
        assertEquals(2, removed.get());
        assertFalse(session.isRunning());
        assertFalse(session.hasActiveListenersFor("uid1"));
        assertFalse(session.requestEnsureStarted(true, "uid1", "restart", false));
        assertEquals("restart", session.onDestroyed());
        assertNull(session.onDestroyed());
        assertEquals(2, removed.get());
    }

    @Test
    public void revokingEnrollmentApprovalClearsApprovalAndDetachesListenersWithoutRemovingAppliedRestrictions() throws Exception {
        Application app = RuntimeEnvironment.getApplication();
        PolicySyncService.SESSION.onDestroyed();
        Shadows.shadowOf(app).clearStartedServices();

        DevicePolicyManager dpm = (DevicePolicyManager) app.getSystemService(Context.DEVICE_POLICY_SERVICE);
        ComponentName admin = new ComponentName(app, AdminReceiver.class);
        Shadows.shadowOf(dpm).setDeviceOwner(admin);
        dpm.addUserRestriction(admin, UserManager.DISALLOW_CONFIG_TETHERING);
        // Robolectric stores DPM-added restrictions in ShadowUserManager; verify effective restriction.
        assertTrue(((UserManager) app.getSystemService(Context.USER_SERVICE))
                .hasUserRestriction(UserManager.DISALLOW_CONFIG_TETHERING));

        SharedPreferences prefs = app.getSharedPreferences(SyncEngine.PREFS_NAME, Context.MODE_PRIVATE);
        Set<String> hiddenApps = new HashSet<>(Set.of("com.zhiliaoapp.musically"));
        prefs.edit()
                .putLong(SyncEngine.KEY_REVISION, 4L)
                .putStringSet("hidden_by_agent", hiddenApps)
                .commit();
        SyncEngine.recordApprovalState(prefs, "uid1", true);
        assertTrue(SyncEngine.isDeviceApproved(app, "uid1"));

        AtomicInteger attached = new AtomicInteger(0);
        AtomicInteger removed = new AtomicInteger(0);
        AtomicInteger authAttached = new AtomicInteger(0);
        AtomicInteger authRemoved = new AtomicInteger(0);
        PolicySyncService.setAuthRegistrarOverrideForTest(callback -> {
            authAttached.incrementAndGet();
            return authRemoved::incrementAndGet;
        });
        PolicySyncService.setListenerFactoryOverrideForTest(new PolicySyncService.ListenerFactory() {
            @Override
            public PolicySyncService.ListenerHandle attachEnrollmentListener(String uid) {
                attached.incrementAndGet();
                return removed::incrementAndGet;
            }

            @Override
            public PolicySyncService.ListenerHandle attachPolicyListener(String uid) {
                attached.incrementAndGet();
                return removed::incrementAndGet;
            }
        });

        CountDownLatch revocationSyncIdle = new CountDownLatch(1);
        SyncEngine.setEnrollmentProviderForTest(new SyncEngine.ServerEnrollmentProvider() {
            @Override
            public String getCurrentUid() {
                return "uid1";
            }

            @Override
            public SyncEngine.EnrollmentRecord fetchServerEnrollment(String uid) {
                return new SyncEngine.EnrollmentRecord(true, false);
            }
        });
        SyncEngine.setDirectStatusListenerForTest((inProgress, message) -> {
            if (!inProgress && message != null && message.contains("بانتظار اعتماد الجهاز")) {
                revocationSyncIdle.countDown();
            }
        });

        ServiceController<PolicySyncService> serviceController = null;
        try {
            // Start the real PolicySyncService through the production entry point
            PolicySyncService.ensureStartedAfterVerifiedSync(app, "sync_verified_initial");
            Intent startedIntent = Shadows.shadowOf(app).getNextStartedService();
            assertNotNull(startedIntent);
            serviceController = Robolectric.buildService(PolicySyncService.class, startedIntent)
                    .create()
                    .startCommand(0, 1);

            assertTrue(PolicySyncService.isRunning());
            assertTrue(PolicySyncService.SESSION.hasActiveListenersFor("uid1"));
            assertEquals(1, authAttached.get());
            assertEquals(0, authRemoved.get());
            assertEquals(2, attached.get());
            assertEquals(0, removed.get());

            // Deliver server enrollment revocation snapshot through the production listener handler,
            // which calls SyncEngine.requestSync -> SyncEngine.sync -> recordApprovalState(false) + stopIfRunning.
            assertTrue(PolicySyncService.onEnrollmentSnapshotReceived(app, "uid1", false, false));
            assertTrue(revocationSyncIdle.await(5, TimeUnit.SECONDS));

            assertFalse(SyncEngine.isSyncInProgress());
            assertFalse(SyncEngine.isDeviceApproved(app, "uid1"));
            assertFalse(PolicySyncService.isRunning());
            assertFalse(PolicySyncService.SESSION.hasActiveListenersFor("uid1"));
            assertEquals(2, removed.get());

            Intent stoppedService = Shadows.shadowOf(app).getNextStoppedService();
            assertNotNull("PolicySyncService.stopIfRunning must call Context.stopService", stoppedService);
            assertEquals(PolicySyncService.class.getName(), stoppedService.getComponent().getClassName());

            // Complete Android service destruction lifecycle and verify it stays STOPPED without restarting
            serviceController.destroy();
            assertEquals(1, authRemoved.get());
            assertEquals(PolicySyncService.LifecycleState.STOPPED,
                    PolicySyncService.SESSION.getState());
            assertNull(Shadows.shadowOf(app).getNextStartedService());

            // Applied policy revision, hidden apps, and tethering restriction remain strictly intact
            // Robolectric stores DPM-added restrictions in ShadowUserManager; verify effective restriction.
        assertTrue(((UserManager) app.getSystemService(Context.USER_SERVICE))
                .hasUserRestriction(UserManager.DISALLOW_CONFIG_TETHERING));
            assertEquals(4L, prefs.getLong(SyncEngine.KEY_REVISION, 0L));
            assertEquals(hiddenApps, prefs.getStringSet("hidden_by_agent", Collections.emptySet()));
        } finally {
            SyncEngine.setDirectStatusListenerForTest(null);
            SyncEngine.setEnrollmentProviderForTest(null);
            PolicySyncService.setListenerFactoryOverrideForTest(null);
            PolicySyncService.setAuthRegistrarOverrideForTest(null);
            PolicySyncService.SESSION.onDestroyed();
        }
    }

    @Test
    public void pushHintMustMatchSignedInDeviceAndContainsNoEnforcementAuthority() {
        Map<String, String> hint = new HashMap<>();
        hint.put("type", "policy_sync");
        hint.put("uid", "device1");
        assertTrue(PolicyMessagingService.validHint(hint, "device1"));
        assertFalse(PolicyMessagingService.validHint(hint, "device2"));
        assertFalse(PolicyMessagingService.validHint(hint, null));
        hint.put("type", "unlock");
        assertFalse(PolicyMessagingService.validHint(hint, "device1"));
    }
}

package com.company.mdmagent;

import org.junit.Test;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;

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
    public void notificationVisibilityChecksRuntimePermissionOnAndroid13Plus() {
        // Android 13+ (API 33+) requires both POST_NOTIFICATIONS and app notifications enabled
        assertTrue(PolicySyncService.isNotificationPermitted(33, true, true));
        assertFalse(PolicySyncService.isNotificationPermitted(33, false, true));
        assertFalse(PolicySyncService.isNotificationPermitted(34, true, false));
        // Android 12 and below only check app notifications enabled
        assertTrue(PolicySyncService.isNotificationPermitted(31, false, true));
        assertFalse(PolicySyncService.isNotificationPermitted(31, true, false));
    }

    @Test
    public void syncStabilizesAfterServiceStartWithoutSelfSustainingLoop() {
        PolicySyncService.ServiceSessionController session = new PolicySyncService.ServiceSessionController();
        AtomicInteger startServiceCalls = new AtomicInteger(0);
        AtomicInteger executedSyncs = new AtomicInteger(0);

        PolicySyncService.ListenerFactory factory = new PolicySyncService.ListenerFactory() {
            @Override
            public PolicySyncService.ListenerHandle attachEnrollmentListener(String uid) {
                return () -> {};
            }

            @Override
            public PolicySyncService.ListenerHandle attachPolicyListener(String uid) {
                return () -> {};
            }
        };

        // Cold start of service (e.g., after reboot) when no sync has run yet in this session
        boolean shouldCallStart = session.requestEnsureStarted(true, "uid1", "boot_completed", false);
        assertTrue(shouldCallStart);
        startServiceCalls.incrementAndGet();

        // Calling requestEnsureStarted again while STARTING must be a no-op
        assertFalse(session.requestEnsureStarted(true, "uid1", "duplicate_boot", false));

        // Service enters onStartCommand
        PolicySyncService.StartCommandPlan plan = session.onStartCommand(true, true, "uid1", false);
        assertFalse(plan.shouldStop);
        assertTrue(plan.triggerInitialSync);
        assertTrue(session.attachListenersIfNeeded("uid1", factory));

        // The single initial sync runs and, upon completion, SyncEngine calls ensureStartedAfterVerifiedSync
        SyncEngine.QueueCoordinator coordinator = new SyncEngine.QueueCoordinator(
                Runnable::run,
                trigger -> {
                    executedSyncs.incrementAndGet();
                    // Simulate SyncEngine.sync finishing and ensuring service is started
                    boolean startAgain = session.requestEnsureStarted(true, "uid1", "sync_verified", true);
                    if (startAgain) {
                        startServiceCalls.incrementAndGet();
                    }
                    return "ok";
                },
                null
        );

        coordinator.submit("fgs_initial_boot_completed");

        // Exactly 1 service start and 1 sync execution; no self-sustaining loop
        assertEquals(1, startServiceCalls.get());
        assertEquals(1, executedSyncs.get());
        assertTrue(session.isRunning());

        // Repeated ensureStarted calls on a healthy running service must be no-ops
        assertFalse(session.requestEnsureStarted(true, "uid1", "repeated_check_1", false));
        assertFalse(session.requestEnsureStarted(true, "uid1", "repeated_check_2", true));

        // Even if the OS delivers onStartCommand again for the same running UID, triggerInitialSync is false
        PolicySyncService.StartCommandPlan redeliveredPlan = session.onStartCommand(true, true, "uid1", false);
        assertFalse(redeliveredPlan.shouldStop);
        assertFalse(redeliveredPlan.triggerInitialSync);
        assertEquals(1, startServiceCalls.get());
        assertEquals(1, executedSyncs.get());
    }

    @Test
    public void completingSuccessfulSyncDoesNotGenerateNewSyncRequest() {
        PolicySyncService.ServiceSessionController session = new PolicySyncService.ServiceSessionController();
        AtomicInteger executedSyncs = new AtomicInteger(0);

        PolicySyncService.ListenerFactory factory = new PolicySyncService.ListenerFactory() {
            @Override
            public PolicySyncService.ListenerHandle attachEnrollmentListener(String uid) {
                return () -> {};
            }

            @Override
            public PolicySyncService.ListenerHandle attachPolicyListener(String uid) {
                return () -> {};
            }
        };

        SyncEngine.QueueCoordinator[] coordinatorRef = new SyncEngine.QueueCoordinator[1];
        coordinatorRef[0] = new SyncEngine.QueueCoordinator(
                Runnable::run,
                trigger -> {
                    executedSyncs.incrementAndGet();
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

        // First manual sync starts the service for the first time
        coordinatorRef[0].submit("ui_manual_button");
        assertEquals(1, executedSyncs.get());
        assertTrue(session.isRunning());

        // Second sync (e.g., from policy listener) completes while service is already running
        coordinatorRef[0].submit("fgs_policy_snapshot");
        assertEquals(2, executedSyncs.get());
    }

    @Test
    public void syncRequestArrivingDuringQueueDrainCompletionIsNeverLost() throws Exception {
        ExecutorService singleThread = Executors.newSingleThreadExecutor();
        try {
            CountDownLatch firstSyncFinishing = new CountDownLatch(1);
            CountDownLatch secondRequestSubmitted = new CountDownLatch(1);
            CountDownLatch bothFinished = new CountDownLatch(2);
            List<String> executedTriggers = new ArrayList<>();

            SyncEngine.QueueCoordinator coordinator = new SyncEngine.QueueCoordinator(
                    singleThread::execute,
                    trigger -> {
                        synchronized (executedTriggers) {
                            executedTriggers.add(trigger);
                        }
                        if ("first_sync".equals(trigger)) {
                            firstSyncFinishing.countDown();
                            assertTrue(secondRequestSubmitted.await(5, TimeUnit.SECONDS));
                        }
                        bothFinished.countDown();
                        return "done:" + trigger;
                    },
                    null
            );

            assertTrue(coordinator.submit("first_sync"));
            assertTrue(firstSyncFinishing.await(5, TimeUnit.SECONDS));

            // Submit second request right as the first sync is about to finish
            assertFalse(coordinator.submit("second_sync_during_finish"));
            secondRequestSubmitted.countDown();

            assertTrue(bothFinished.await(5, TimeUnit.SECONDS));
            synchronized (executedTriggers) {
                assertEquals(List.of("first_sync", "second_sync_during_finish"), executedTriggers);
            }
        } finally {
            singleThread.shutdownNow();
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


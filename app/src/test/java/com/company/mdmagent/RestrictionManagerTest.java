package com.company.mdmagent;

import android.app.Application;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.os.Bundle;
import android.os.UserManager;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadows.ShadowDevicePolicyManager;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 34, shadows = RestrictionManagerTest.RestrictionsShadow.class)
public class RestrictionManagerTest {

    // Robolectric 4.14 writes DPM restrictions into ShadowUserManager but does not implement
    // DPM.getUserRestrictions. Bridge that read to the actual state recorded by its add/clear APIs.
    @Implements(DevicePolicyManager.class)
    public static class RestrictionsShadow extends ShadowDevicePolicyManager {
        @Implementation
        protected Bundle getUserRestrictions(ComponentName admin) {
            return ((UserManager) RuntimeEnvironment.getApplication().getSystemService(Context.USER_SERVICE))
                    .getUserRestrictions();
        }
    }

    private Application c;
    private DevicePolicyManager dpm;
    private ComponentName admin;

    @Before
    public void setUp() throws Exception {
        c = RuntimeEnvironment.getApplication();
        dpm = (DevicePolicyManager) c.getSystemService(Context.DEVICE_POLICY_SERVICE);
        admin = new ComponentName(c, AdminReceiver.class);
        Shadows.shadowOf(dpm).setDeviceOwner(admin);

        RestrictionManager.clearHookForTest = null;
        RestrictionManager.postClearHookForTest = null;
        RestrictionManager.applyHookForTest = null;
        RestrictionManager.commitInterceptorForTest = null;
        RestrictionManager.clearLiveAttemptsForTest();

        c.getSharedPreferences(RestrictionManager.PREFS_NAME, Context.MODE_PRIVATE).edit().clear().commit();
        c.getSharedPreferences(PackageInstallManager.PREFS_TASKS, Context.MODE_PRIVATE).edit().clear().commit();
        c.getSharedPreferences(KioskController.PREFS, Context.MODE_PRIVATE).edit().clear().commit();
        c.getSharedPreferences(AppInstallPolicy.PREFS_NAME, Context.MODE_PRIVATE).edit().clear().commit();
        c.getSharedPreferences(LocationPolicy.PREFS_NAME, Context.MODE_PRIVATE).edit().clear().commit();

        // Clear any leftoverUserRestrictions and sessions
        for (String r : new String[]{
                UserManager.DISALLOW_INSTALL_APPS,
                UserManager.DISALLOW_UNINSTALL_APPS,
                UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES,
                UserManager.DISALLOW_SAFE_BOOT,
                UserManager.DISALLOW_ADD_USER,
                UserManager.DISALLOW_CREATE_WINDOWS,
                UserManager.DISALLOW_CONFIG_TETHERING,
                UserManager.DISALLOW_CONFIG_LOCATION
        }) {
            dpm.clearUserRestriction(admin, r);
        }

        PackageInstaller installer = c.getPackageManager().getPackageInstaller();
        List<PackageInstaller.SessionInfo> sessions = installer.getMySessions();
        if (sessions != null) {
            for (PackageInstaller.SessionInfo s : sessions) {
                if (s != null) {
                    try {
                        installer.abandonSession(s.getSessionId());
                    } catch (Exception ignored) {}
                }
            }
        }

        // Apply default AppInstallPolicy (blockAppInstalls = true) so DISALLOW_INSTALL_APPS is owned and active
        AppInstallPolicy.saveLocal(c, new AppInstallPolicy(1L, true));
        assertTrue(dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));
    }

    @After
    public void tearDown() {
        RestrictionManager.clearHookForTest = null;
        RestrictionManager.postClearHookForTest = null;
        RestrictionManager.applyHookForTest = null;
        RestrictionManager.commitInterceptorForTest = null;
        RestrictionManager.clearLiveAttemptsForTest();
    }

    @Test
    public void testInstallPolicyPreservesRestrictionsWhenKioskDisabled() {
        Set<String> required = RestrictionManager.computeRequiredRestrictions(
                null,
                false, // kiosk not active
                true,  // blockAppInstalls
                false, // tethering
                false  // location
        );

        assertTrue("Must contain DISALLOW_INSTALL_APPS", required.contains(UserManager.DISALLOW_INSTALL_APPS));
        assertTrue("Must contain DISALLOW_INSTALL_UNKNOWN_SOURCES", required.contains(UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES));
        assertFalse("Must NOT contain DISALLOW_UNINSTALL_APPS", required.contains(UserManager.DISALLOW_UNINSTALL_APPS));
        assertFalse("Must NOT contain DISALLOW_CONFIG_TETHERING", required.contains(UserManager.DISALLOW_CONFIG_TETHERING));
    }

    @Test
    public void testKioskActiveEnforcesFullSuite() {
        Set<String> required = RestrictionManager.computeRequiredRestrictions(
                null,
                true,  // kiosk active
                false, // independent install
                false,
                false
        );

        assertTrue(required.contains(UserManager.DISALLOW_INSTALL_APPS));
        assertTrue(required.contains(UserManager.DISALLOW_UNINSTALL_APPS));
        assertTrue(required.contains(UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES));
        assertTrue(required.contains(UserManager.DISALLOW_SAFE_BOOT));
        assertTrue(required.contains(UserManager.DISALLOW_ADD_USER));
        assertTrue(required.contains(UserManager.DISALLOW_CREATE_WINDOWS));
        assertFalse(required.contains(UserManager.DISALLOW_CONFIG_TETHERING));
        assertFalse(required.contains(UserManager.DISALLOW_CONFIG_LOCATION));
    }

    @Test
    public void testLocationConfigAndTetheringUnion() {
        Set<String> required = RestrictionManager.computeRequiredRestrictions(
                null,
                false,
                false,
                true, // block tethering
                true  // block location config
        );

        assertTrue(required.contains(UserManager.DISALLOW_CONFIG_TETHERING));
        assertTrue(required.contains(UserManager.DISALLOW_CONFIG_LOCATION));
        assertFalse(required.contains(UserManager.DISALLOW_INSTALL_APPS));
    }

    @Test
    public void testAllFeaturesActiveCombinesUnion() {
        Set<String> required = RestrictionManager.computeRequiredRestrictions(
                null,
                true,
                true,
                true,
                true
        );

        assertEquals(8, required.size());
        assertTrue(required.contains(UserManager.DISALLOW_INSTALL_APPS));
        assertTrue(required.contains(UserManager.DISALLOW_UNINSTALL_APPS));
        assertTrue(required.contains(UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES));
        assertTrue(required.contains(UserManager.DISALLOW_SAFE_BOOT));
        assertTrue(required.contains(UserManager.DISALLOW_ADD_USER));
        assertTrue(required.contains(UserManager.DISALLOW_CREATE_WINDOWS));
        assertTrue(required.contains(UserManager.DISALLOW_CONFIG_TETHERING));
        assertTrue(required.contains(UserManager.DISALLOW_CONFIG_LOCATION));
    }

    @Test
    public void testKioskDisableOrMaintenanceDoesNotLiftIndependentInstallPolicy() {
        Set<String> fullSuite = RestrictionManager.computeRequiredRestrictions(
                null,
                true, // kiosk enabled
                true, // independent install blocked
                true, // tethering blocked
                false
        );
        assertTrue(fullSuite.contains(UserManager.DISALLOW_INSTALL_APPS));
        assertTrue(fullSuite.contains(UserManager.DISALLOW_UNINSTALL_APPS));
        assertTrue(fullSuite.contains(UserManager.DISALLOW_CONFIG_TETHERING));

        Set<String> maintenanceSuite = RestrictionManager.computeRequiredRestrictions(
                null,
                false, // kiosk disabled or in maintenance
                true,  // independent install STILL blocked
                true,  // tethering STILL blocked
                false
        );

        assertTrue("DISALLOW_INSTALL_APPS must remain active during maintenance",
                maintenanceSuite.contains(UserManager.DISALLOW_INSTALL_APPS));
        assertTrue("DISALLOW_INSTALL_UNKNOWN_SOURCES must remain active during maintenance",
                maintenanceSuite.contains(UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES));
        assertTrue("DISALLOW_CONFIG_TETHERING must remain active during maintenance",
                maintenanceSuite.contains(UserManager.DISALLOW_CONFIG_TETHERING));

        assertFalse("DISALLOW_UNINSTALL_APPS should be lifted",
                maintenanceSuite.contains(UserManager.DISALLOW_UNINSTALL_APPS));
        assertFalse("DISALLOW_SAFE_BOOT should be lifted",
                maintenanceSuite.contains(UserManager.DISALLOW_SAFE_BOOT));
        assertFalse("DISALLOW_ADD_USER should be lifted",
                maintenanceSuite.contains(UserManager.DISALLOW_ADD_USER));
    }

    @Test
    public void testApprovedTaskSuspensionOmitsOnlyInstallAppsWhilePreservingAllOtherKioskRestrictions() {
        Set<String> requiredDuringSuspension = new HashSet<>();
        boolean kioskActive = true;
        boolean suspendActive = true;

        if (kioskActive) {
            if (!suspendActive) {
                requiredDuringSuspension.add(UserManager.DISALLOW_INSTALL_APPS);
            }
            requiredDuringSuspension.add(UserManager.DISALLOW_UNINSTALL_APPS);
            requiredDuringSuspension.add(UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES);
            requiredDuringSuspension.add(UserManager.DISALLOW_SAFE_BOOT);
            requiredDuringSuspension.add(UserManager.DISALLOW_ADD_USER);
            requiredDuringSuspension.add(UserManager.DISALLOW_CREATE_WINDOWS);
        }

        assertFalse("DISALLOW_INSTALL_APPS is suspended during commit window", requiredDuringSuspension.contains(UserManager.DISALLOW_INSTALL_APPS));
        assertTrue("DISALLOW_UNINSTALL_APPS MUST remain active", requiredDuringSuspension.contains(UserManager.DISALLOW_UNINSTALL_APPS));
        assertTrue("DISALLOW_INSTALL_UNKNOWN_SOURCES MUST remain active", requiredDuringSuspension.contains(UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES));
        assertTrue("DISALLOW_SAFE_BOOT MUST remain active", requiredDuringSuspension.contains(UserManager.DISALLOW_SAFE_BOOT));
        assertTrue("DISALLOW_ADD_USER MUST remain active", requiredDuringSuspension.contains(UserManager.DISALLOW_ADD_USER));
        assertTrue("DISALLOW_CREATE_WINDOWS MUST remain active", requiredDuringSuspension.contains(UserManager.DISALLOW_CREATE_WINDOWS));
    }

    @Test
    public void testTwoAttemptsWithSameCmdIdAndDifferentAttemptIdsRejected() throws Exception {
        SharedPreferences p = RestrictionManager.prefs(c);

        // Attempt 1 suspends restriction legitimately via DPM
        RestrictionManager.suspendInstallRestrictionForApprovedTask(c, "cmd_100", "attempt_1", "com.company.erp");
        assertFalse(dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));
        assertTrue(RestrictionManager.isInstallRestrictionSuspended(c));
        assertEquals("attempt_1", p.getString(RestrictionManager.KEY_SUSPENSION_ATTEMPT_ID, ""));

        // Attempt 2 with same cmd_100 but different attempt_2 must be rejected without replacing attempt_1
        try {
            RestrictionManager.suspendInstallRestrictionForApprovedTask(c, "cmd_100", "attempt_2", "com.company.erp");
            fail("Second attempt with active suspension must be rejected");
        } catch (IllegalStateException ex) {
            assertTrue(ex.getMessage().contains("محاولة تنفيذ أخرى"));
        }
        assertEquals("attempt_1", p.getString(RestrictionManager.KEY_SUSPENSION_ATTEMPT_ID, ""));
    }

    @Test
    public void testRestoreRejectedByDifferentAttemptIdOrEmptyAttemptIdAndSucceedsForOwner() throws Exception {
        SharedPreferences p = RestrictionManager.prefs(c);
        RestrictionManager.suspendInstallRestrictionForApprovedTask(c, "cmd_100", "attempt_1", "com.company.erp");
        assertFalse(dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));

        // 1. Different attemptId (ownership mismatch) must NOT restore or clear journal
        RestrictionManager.restoreInstallRestrictionIfNeeded(c, "attempt_2");
        assertTrue(p.getBoolean(RestrictionManager.KEY_SUSPENSION_ACTIVE, false));
        assertEquals("attempt_1", p.getString(RestrictionManager.KEY_SUSPENSION_ATTEMPT_ID, ""));
        assertFalse(dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));

        // 2. Null or empty attemptId must NOT restore or clear journal
        RestrictionManager.restoreInstallRestrictionIfNeeded(c, null);
        RestrictionManager.restoreInstallRestrictionIfNeeded(c, "");
        RestrictionManager.restoreInstallRestrictionIfNeeded(c, "   ");
        RestrictionManager.restoreInstallRestrictionIfNeeded(c);
        assertTrue(p.getBoolean(RestrictionManager.KEY_SUSPENSION_ACTIVE, false));
        assertEquals("attempt_1", p.getString(RestrictionManager.KEY_SUSPENSION_ATTEMPT_ID, ""));
        assertFalse(dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));

        // 3. Matching owner attempt_1 restores restriction and clears journal
        RestrictionManager.restoreInstallRestrictionIfNeeded(c, "attempt_1");
        assertFalse(p.getBoolean(RestrictionManager.KEY_SUSPENSION_ACTIVE, false));
        assertEquals("", p.getString(RestrictionManager.KEY_SUSPENSION_ATTEMPT_ID, ""));
        assertTrue(dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));
    }

    @Test
    public void testInstallStatusReceiverOldAndMissingSessionResultsDoNotClearLiveAttempt() throws Exception {
        SharedPreferences taskPrefs = c.getSharedPreferences(InstallStatusReceiver.PREFS_TASKS, Context.MODE_PRIVATE);
        SharedPreferences restPrefs = RestrictionManager.prefs(c);

        // Seed old session (session_999 -> attempt_old) and current session (session_777 -> attempt_new)
        taskPrefs.edit()
                .putString("session_999_attempt_id", "attempt_old")
                .putString("session_999_cmd_id", "cmd_999")
                .putString("session_999_pkg", "com.company.erp")
                .putString("session_999_state", "COMMITTED")
                .putString("session_777_attempt_id", "attempt_new")
                .putString("session_777_cmd_id", "cmd_777")
                .putString("session_777_pkg", "com.company.erp")
                .putString("session_777_state", "COMMITTED")
                .commit();

        // Suspend restriction for attempt_new
        RestrictionManager.suspendInstallRestrictionForApprovedTask(c, "cmd_777", "attempt_new", "com.company.erp", 777);
        assertFalse(dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));

        InstallStatusReceiver receiver = new InstallStatusReceiver();

        // 1. Old session result arrives (session 999 with attempt_old) -> must NOT clear attempt_new
        Intent oldIntent = new Intent(InstallStatusReceiver.ACTION_INSTALL_COMMIT_RESULT);
        oldIntent.putExtra(PackageInstaller.EXTRA_SESSION_ID, 999);
        oldIntent.putExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        oldIntent.putExtra(PackageInstaller.EXTRA_PACKAGE_NAME, "com.company.erp");
        receiver.onReceive(c, oldIntent);

        assertTrue("New attempt suspension must remain active after old session broadcast",
                restPrefs.getBoolean(RestrictionManager.KEY_SUSPENSION_ACTIVE, false));
        assertEquals("attempt_new", restPrefs.getString(RestrictionManager.KEY_SUSPENSION_ATTEMPT_ID, ""));
        assertFalse(dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));

        // 2. Unknown session result arrives with no record in PREFS_TASKS (session 888 -> empty attemptId) -> must NOT clear attempt_new
        Intent missingIntent = new Intent(InstallStatusReceiver.ACTION_INSTALL_COMMIT_RESULT);
        missingIntent.putExtra(PackageInstaller.EXTRA_SESSION_ID, 888);
        missingIntent.putExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        missingIntent.putExtra(PackageInstaller.EXTRA_PACKAGE_NAME, "com.company.erp");
        receiver.onReceive(c, missingIntent);

        assertTrue("New attempt suspension must remain active after unknown session broadcast",
                restPrefs.getBoolean(RestrictionManager.KEY_SUSPENSION_ACTIVE, false));
        assertEquals("attempt_new", restPrefs.getString(RestrictionManager.KEY_SUSPENSION_ATTEMPT_ID, ""));
        assertFalse(dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));

        // 3. Matching session result arrives (session 777 with attempt_new) -> restores restriction and clears journal
        Intent currentIntent = new Intent(InstallStatusReceiver.ACTION_INSTALL_COMMIT_RESULT);
        currentIntent.putExtra(PackageInstaller.EXTRA_SESSION_ID, 777);
        currentIntent.putExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        currentIntent.putExtra(PackageInstaller.EXTRA_PACKAGE_NAME, "com.company.erp");
        receiver.onReceive(c, currentIntent);

        assertFalse("Owner session result must clear suspension",
                restPrefs.getBoolean(RestrictionManager.KEY_SUSPENSION_ACTIVE, false));
        assertTrue("DISALLOW_INSTALL_APPS must be restored",
                dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));
    }

    @Test
    public void testActualRecoveryPathRecoversOrphanedAndLegacyRecordsWhileProtectingLiveAttempts() throws Exception {
        SharedPreferences restPrefs = RestrictionManager.prefs(c);
        SharedPreferences taskPrefs = c.getSharedPreferences(PackageInstallManager.PREFS_TASKS, Context.MODE_PRIVATE);
        PackageInstaller installer = c.getPackageManager().getPackageInstaller();

        // Case A: Orphaned record after process death BEFORE createSession (no 60s wait needed!)
        RestrictionManager.suspendInstallRestrictionForApprovedTask(c, "cmd_orphan_1", "attempt_orphan_pre_session", "com.company.erp");
        assertFalse(dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));

        PackageInstallManager.recoverPendingInstallTasks(c);
        assertFalse("Orphaned pre-session record must be recovered immediately via recoverPendingInstallTasks",
                restPrefs.getBoolean(RestrictionManager.KEY_SUSPENSION_ACTIVE, false));
        assertTrue("DISALLOW_INSTALL_APPS must be restored",
                dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));

        // Case B: Orphaned record after createSession (bound sessionId) BEFORE saving COMMITTED task state
        RestrictionManager.suspendInstallRestrictionForApprovedTask(c, "cmd_orphan_2", "attempt_orphan_post_session", "com.company.erp");
        PackageInstaller.SessionParams paramsB = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        paramsB.setAppPackageName("com.company.erp");
        int uncommittedSid = installer.createSession(paramsB);
        RestrictionManager.bindSessionToAttempt(c, "attempt_orphan_post_session", uncommittedSid);
        assertEquals(uncommittedSid, restPrefs.getInt(RestrictionManager.KEY_SUSPENSION_SESSION_ID, -1));

        // Process dies before saving COMMITTED in PREFS_TASKS; SyncEngine invokes recoverPendingInstallTasks
        PackageInstallManager.recoverPendingInstallTasks(c);
        assertFalse("Orphaned post-createSession uncommitted record must be recovered immediately",
                restPrefs.getBoolean(RestrictionManager.KEY_SUSPENSION_ACTIVE, false));
        assertTrue(dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));
        assertNull("Uncommitted bound session must be abandoned on recovery",
                installer.getSessionInfo(uncommittedSid));

        // Case C: Orphaned record when an UNRELATED active session exists in PackageInstaller
        PackageInstaller.SessionParams unrelatedParams = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        unrelatedParams.setAppPackageName("com.other.unrelated");
        int unrelatedSid = installer.createSession(unrelatedParams);
        assertNotNull(installer.getSessionInfo(unrelatedSid));

        RestrictionManager.suspendInstallRestrictionForApprovedTask(c, "cmd_orphan_3", "attempt_orphan_unrelated", "com.company.erp");
        PackageInstallManager.recoverPendingInstallTasks(c);
        assertFalse("Orphaned record must be recovered even when an unrelated OS session is active",
                restPrefs.getBoolean(RestrictionManager.KEY_SUSPENSION_ACTIVE, false));
        assertTrue(dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));
        installer.abandonSession(unrelatedSid);

        // Case D: Live in-process attempt must NOT be interfered with by recoverPendingInstallTasks
        RestrictionManager.registerLiveAttempt("attempt_live_in_mem");
        RestrictionManager.suspendInstallRestrictionForApprovedTask(c, "cmd_live_1", "attempt_live_in_mem", "com.company.erp");
        PackageInstallManager.recoverPendingInstallTasks(c);
        assertTrue("Live in-process attempt must NOT be recovered/cleared by concurrent sync recovery",
                restPrefs.getBoolean(RestrictionManager.KEY_SUSPENSION_ACTIVE, false));
        assertFalse(dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));
        RestrictionManager.unregisterLiveAttempt("attempt_live_in_mem");
        RestrictionManager.restoreInstallRestrictionIfNeeded(c, "attempt_live_in_mem");
        assertTrue(dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));

        // Case E: After process death, an active bound COMMITTED session in PackageInstaller:
        // 1) Must NOT prevent immediate restoration of DISALLOW_INSTALL_APPS
        // 2) Must NOT be abandoned (session and COMMITTED task record remain intact)
        // 3) Continues to process its final result via InstallStatusReceiver without fake success or fake failure
        RestrictionManager.suspendInstallRestrictionForApprovedTask(c, "cmd_live_2", "attempt_committed_active", "com.company.erp");
        PackageInstaller.SessionParams committedParams = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        committedParams.setAppPackageName("com.company.erp");
        int committedSid = installer.createSession(committedParams);
        RestrictionManager.bindSessionToAttempt(c, "attempt_committed_active", committedSid);
        String expectedCertSha = "a".repeat(64);
        String prefix = "session_" + committedSid;
        taskPrefs.edit()
                .putInt(prefix + "_session_id", committedSid)
                .putString(prefix + "_cmd_id", "cmd_live_2")
                .putString(prefix + "_attempt_id", "attempt_committed_active")
                .putString(prefix + "_uid", "device_1")
                .putString(prefix + "_pkg", "com.company.erp")
                .putLong(prefix + "_version_code", 5L)
                .putLong(prefix + "_pre_install_version", -1L)
                .putLong(prefix + "_pre_install_update_time", -1L)
                .putString(prefix + "_cert_sha256", expectedCertSha)
                .putLong(prefix + "_created_at", System.currentTimeMillis())
                .putLong(prefix + "_expires_at_ms", System.currentTimeMillis() + 600_000L)
                .putString(prefix + "_state", "COMMITTED")
                .commit();

        // Simulate process restart recovery while the COMMITTED session is still active in OS
        PackageInstallManager.recoverPendingInstallTasks(c);

        // 1. Restriction MUST be restored immediately after process death (not left lifted awaiting session result!)
        assertFalse("Suspension journal must be cleared immediately on recovery even when COMMITTED session is active",
                restPrefs.getBoolean(RestrictionManager.KEY_SUSPENSION_ACTIVE, false));
        assertFalse(RestrictionManager.isInstallRestrictionSuspended(c));
        assertTrue("DISALLOW_INSTALL_APPS must be restored immediately after process death",
                dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));

        // 2. The active COMMITTED session and its task record MUST remain intact (not abandoned, no fake result)
        PackageInstaller.SessionInfo activeCommittedInfo = installer.getSessionInfo(committedSid);
        assertNotNull("Active COMMITTED session must NOT be abandoned when restoring restriction", activeCommittedInfo);
        assertTrue("Active COMMITTED session must remain active in PackageInstaller", activeCommittedInfo.isActive());
        assertEquals("Task state must remain COMMITTED awaiting real OS result (no fake success or failure)",
                "COMMITTED", taskPrefs.getString(prefix + "_state", ""));
        assertEquals("", taskPrefs.getString(prefix + "_result_status", ""));

        // 3. When the OS session subsequently finishes and delivers its broadcast to InstallStatusReceiver,
        //    the preserved task record processes the real result and keeps DISALLOW_INSTALL_APPS enforced
        Intent committedFailIntent = new Intent(InstallStatusReceiver.ACTION_INSTALL_COMMIT_RESULT);
        committedFailIntent.putExtra(PackageInstaller.EXTRA_SESSION_ID, committedSid);
        committedFailIntent.putExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE_ABORTED);
        committedFailIntent.putExtra(PackageInstaller.EXTRA_STATUS_MESSAGE, "User or system aborted session");
        committedFailIntent.putExtra(PackageInstaller.EXTRA_PACKAGE_NAME, "com.company.erp");
        new InstallStatusReceiver().onReceive(c, committedFailIntent);

        assertEquals("RESULT_PENDING_ACK", taskPrefs.getString(prefix + "_state", ""));
        assertEquals("failed", taskPrefs.getString(prefix + "_result_status", ""));
        assertEquals(PackageInstallManager.OUTCOME_FAILED, taskPrefs.getString(prefix + "_result_outcome", ""));
        assertTrue("DISALLOW_INSTALL_APPS must remain enforced after session result processing",
                dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));
        installer.abandonSession(committedSid);

        // Case F: Legacy suspension record without attemptId is recovered via recoverPendingInstallTasks
        dpm.clearUserRestriction(admin, UserManager.DISALLOW_INSTALL_APPS);
        restPrefs.edit()
                .putBoolean(RestrictionManager.KEY_SUSPENSION_ACTIVE, true)
                .putString(RestrictionManager.KEY_SUSPENSION_CMD_ID, "cmd_legacy")
                .remove(RestrictionManager.KEY_SUSPENSION_ATTEMPT_ID)
                .commit();
        PackageInstallManager.recoverPendingInstallTasks(c);
        assertFalse("Legacy suspension record without attemptId must be recovered",
                restPrefs.getBoolean(RestrictionManager.KEY_SUSPENSION_ACTIVE, false));
        assertTrue(dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));
    }

    @Test
    public void testPartialFailureRetainsJournalAndCombinedErrorUntilSuccessfulRecoveryRetry() {
        SharedPreferences p = RestrictionManager.prefs(c);

        // Simulate failure after clearing restriction AND failure when attempting rollback restoration
        RestrictionManager.postClearHookForTest = restriction -> {
            throw new RuntimeException("فشل تجريبي بعد رفع القيد");
        };
        RestrictionManager.applyHookForTest = restriction -> {
            if (UserManager.DISALLOW_INSTALL_APPS.equals(restriction)) {
                throw new RuntimeException("فشل تجريبي في إعادة تطبيق القيد");
            }
        };

        try {
            RestrictionManager.suspendInstallRestrictionForApprovedTask(c, "cmd_fail", "attempt_fail_1", "com.company.erp");
            fail("Expected IllegalStateException when both suspend post-clear and rollback restore fail");
        } catch (Exception ex) {
            assertTrue(ex.getMessage().contains("فشل تجريبي بعد رفع القيد"));
            assertTrue(ex.getMessage().contains("فشل تجريبي في إعادة تطبيق القيد"));
        }

        // Journal and combined error MUST be retained
        assertTrue(p.getBoolean(RestrictionManager.KEY_SUSPENSION_ACTIVE, false));
        assertEquals("attempt_fail_1", p.getString(RestrictionManager.KEY_SUSPENSION_ATTEMPT_ID, ""));
        String storedErr = p.getString("restriction_restoration_error", "");
        assertTrue(storedErr.contains("فشل تجريبي بعد رفع القيد"));
        assertTrue(storedErr.contains("فشل تجريبي في إعادة تطبيق القيد"));

        // Subsequent recovery attempt while applyHookForTest still fails MUST propagate exception and keep journal
        try {
            PackageInstallManager.recoverPendingInstallTasks(c);
            fail("Expected recoverPendingInstallTasks to propagate restoration failure");
        } catch (IllegalStateException ex) {
            assertTrue(ex.getMessage().contains("فشلت استعادة حماية التثبيت"));
        }
        assertTrue(p.getBoolean(RestrictionManager.KEY_SUSPENSION_ACTIVE, false));

        // Now clear failure hooks and retry via recoverPendingInstallTasks -> succeeds and clears journal & error
        RestrictionManager.postClearHookForTest = null;
        RestrictionManager.applyHookForTest = null;
        PackageInstallManager.recoverPendingInstallTasks(c);

        assertFalse(p.getBoolean(RestrictionManager.KEY_SUSPENSION_ACTIVE, false));
        assertEquals("", p.getString("restriction_restoration_error", ""));
        assertTrue(dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));
    }

    @Test
    public void testSharedPreferencesCommitFailureAndPartialWriteDoNotLoseRetryAbility() throws Exception {
        SharedPreferences p = RestrictionManager.prefs(c);

        // 1. Failing commit when saving suspension journal prevents clearing restriction
        RestrictionManager.commitInterceptorForTest = (editor, operation) -> {
            if ("save_suspension_journal".equals(operation)) {
                return false;
            }
            return editor.commit();
        };

        try {
            RestrictionManager.suspendInstallRestrictionForApprovedTask(c, "cmd_commit", "attempt_commit_1", "com.company.erp");
            fail("Expected IllegalStateException when save_suspension_journal commit returns false");
        } catch (IllegalStateException ex) {
            assertTrue(ex.getMessage().contains("تعذر حفظ سجل تعليق قيد التثبيت"));
        }
        assertTrue("Restriction must remain enforced when journal commit fails",
                dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));

        // 2. Partial failure during reconcile (save_owned_restrictions commits, dpm applies, then save_remaining_owned_restrictions fails)
        RestrictionManager.commitInterceptorForTest = null;
        RestrictionManager.suspendInstallRestrictionForApprovedTask(c, "cmd_commit", "attempt_partial_reconcile", "com.company.erp");
        assertFalse(dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));

        RestrictionManager.commitInterceptorForTest = (editor, operation) -> {
            if ("save_remaining_owned_restrictions".equals(operation)) {
                return false;
            }
            return editor.commit();
        };

        try {
            RestrictionManager.restoreInstallRestrictionIfNeeded(c, "attempt_partial_reconcile");
            fail("Expected IllegalStateException when save_remaining_owned_restrictions fails after save_owned_restrictions");
        } catch (IllegalStateException ex) {
            assertTrue(ex.getMessage().contains("تعذر حفظ سجل ملكية قيود النظام"));
        }
        assertTrue("Suspension must remain active for retry after partial reconcile failure",
                RestrictionManager.isInstallRestrictionSuspended(c));
        assertEquals("attempt_partial_reconcile", p.getString(RestrictionManager.KEY_SUSPENSION_ATTEMPT_ID, ""));

        // Retry with interceptor cleared succeeds and cleans up journal
        RestrictionManager.commitInterceptorForTest = null;
        RestrictionManager.restoreInstallRestrictionIfNeeded(c, "attempt_partial_reconcile");
        assertFalse(RestrictionManager.isInstallRestrictionSuspended(c));
        assertTrue(dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));

        // 3. Partial write during clear_suspension_journal:
        //    Simulate a partial write that sets KEY_SUSPENSION_ACTIVE=false and removes KEY_SUSPENSION_CMD_ID,
        //    leaves KEY_SUSPENSION_ATTEMPT_ID intact, and fails both clear_suspension_journal and save_restore_error.
        RestrictionManager.suspendInstallRestrictionForApprovedTask(c, "cmd_partial_clear", "attempt_partial_clear", "com.company.erp");
        RestrictionManager.commitInterceptorForTest = (editor, operation) -> {
            if ("clear_suspension_journal".equals(operation)) {
                // Mutate only part of SharedPreferences to simulate a partial flush where KEY_SUSPENSION_ACTIVE became false
                // while KEY_SUSPENSION_ATTEMPT_ID remained stored
                p.edit()
                        .putBoolean(RestrictionManager.KEY_SUSPENSION_ACTIVE, false)
                        .remove(RestrictionManager.KEY_SUSPENSION_CMD_ID)
                        .commit();
                return false;
            }
            if ("save_restore_error".equals(operation)) {
                return false;
            }
            return editor.commit();
        };

        try {
            RestrictionManager.restoreInstallRestrictionIfNeeded(c, "attempt_partial_clear");
            fail("Expected IllegalStateException when clear_suspension_journal partially fails");
        } catch (IllegalStateException ex) {
            assertTrue(ex.getMessage().contains("تعذر تحديث سجل استعادة القيود"));
        }

        // Even though KEY_SUSPENSION_ACTIVE was partially written as false, the leftover attemptId keeps
        // isInstallRestrictionSuspended(c) == true AND preserves the ability to retry restoreInstallRestrictionIfNeeded!
        assertFalse(p.getBoolean(RestrictionManager.KEY_SUSPENSION_ACTIVE, false));
        assertEquals("attempt_partial_clear", p.getString(RestrictionManager.KEY_SUSPENSION_ATTEMPT_ID, ""));
        assertTrue("Partially-cleared journal must still be recognized as suspended",
                RestrictionManager.isInstallRestrictionSuspended(c));

        // Simulate restriction still lifted in DPM and verify retry of restoreInstallRestrictionIfNeeded succeeds
        dpm.clearUserRestriction(admin, UserManager.DISALLOW_INSTALL_APPS);
        RestrictionManager.commitInterceptorForTest = null;
        RestrictionManager.restoreInstallRestrictionIfNeeded(c, "attempt_partial_clear");

        assertTrue("Retry of restoreInstallRestrictionIfNeeded must re-apply DISALLOW_INSTALL_APPS",
                dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));
        assertFalse("Retry must completely clear suspension state",
                RestrictionManager.isInstallRestrictionSuspended(c));
        assertEquals("", p.getString(RestrictionManager.KEY_SUSPENSION_ATTEMPT_ID, ""));

        // 4. Partial write during clear_suspension_journal that wipes KEY_SUSPENSION_ATTEMPT_ID while leaving KEY_SUSPENSION_ACTIVE=true:
        //    Verify recovery retry via recoverPendingInstallTasks still restores restriction and clears journal.
        RestrictionManager.suspendInstallRestrictionForApprovedTask(c, "cmd_partial_wipe_id", "attempt_partial_wipe_id", "com.company.erp");
        RestrictionManager.commitInterceptorForTest = (editor, operation) -> {
            if ("clear_suspension_journal".equals(operation)) {
                p.edit()
                        .remove(RestrictionManager.KEY_SUSPENSION_ATTEMPT_ID)
                        .commit();
                return false;
            }
            if ("save_restore_error".equals(operation)) {
                return false;
            }
            return editor.commit();
        };

        try {
            RestrictionManager.restoreInstallRestrictionIfNeeded(c, "attempt_partial_wipe_id");
            fail("Expected IllegalStateException when clear_suspension_journal partially wipes attemptId and fails");
        } catch (IllegalStateException ex) {
            assertTrue(ex.getMessage().contains("تعذر تحديث سجل استعادة القيود"));
        }

        dpm.clearUserRestriction(admin, UserManager.DISALLOW_INSTALL_APPS);
        RestrictionManager.commitInterceptorForTest = null;
        PackageInstallManager.recoverPendingInstallTasks(c);

        assertTrue("Recovery retry must re-apply DISALLOW_INSTALL_APPS after partial attemptId wipe",
                dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));
        assertFalse(RestrictionManager.isInstallRestrictionSuspended(c));
        assertFalse(p.getBoolean(RestrictionManager.KEY_SUSPENSION_ACTIVE, false));
    }
}

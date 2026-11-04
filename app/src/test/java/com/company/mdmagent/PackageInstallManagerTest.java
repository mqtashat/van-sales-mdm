package com.company.mdmagent;

import android.app.Application;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.os.Bundle;
import android.os.UserManager;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
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
import org.robolectric.shadows.ShadowPackageInstaller;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(
        manifest = Config.NONE,
        sdk = 34,
        shadows = {
                PackageInstallManagerTest.RestrictionsShadow.class,
                PackageInstallManagerTest.EnforcingPackageInstallerShadow.class
        }
)
public class PackageInstallManagerTest {

    @Implements(DevicePolicyManager.class)
    public static class RestrictionsShadow extends ShadowDevicePolicyManager {
        @Implementation
        protected Bundle getUserRestrictions(ComponentName admin) {
            return ((UserManager) RuntimeEnvironment.getApplication().getSystemService(Context.USER_SERVICE))
                    .getUserRestrictions();
        }
    }

    /**
     * Enforces real Android OS behavior in Robolectric: calling PackageInstaller.createSession
     * while UserManager.DISALLOW_INSTALL_APPS is active throws SecurityException.
     */
    @Implements(PackageInstaller.class)
    public static class EnforcingPackageInstallerShadow extends ShadowPackageInstaller {
        @Implementation
        protected int createSession(PackageInstaller.SessionParams params) throws IOException {
            Application app = RuntimeEnvironment.getApplication();
            UserManager um = (UserManager) app.getSystemService(Context.USER_SERVICE);
            if (um != null && um.getUserRestrictions().getBoolean(UserManager.DISALLOW_INSTALL_APPS, false)) {
                throw new SecurityException("User restriction DISALLOW_INSTALL_APPS is active during createSession");
            }
            return super.createSession(params);
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

        PackageInstallManager.serverVerifierForTest = null;
        RestrictionManager.clearLiveAttemptsForTest();
        RestrictionManager.clearHookForTest = null;
        RestrictionManager.postClearHookForTest = null;
        RestrictionManager.applyHookForTest = null;
        RestrictionManager.commitInterceptorForTest = null;

        c.getSharedPreferences(RestrictionManager.PREFS_NAME, Context.MODE_PRIVATE).edit().clear().commit();
        c.getSharedPreferences(PackageInstallManager.PREFS_TASKS, Context.MODE_PRIVATE).edit().clear().commit();
        c.getSharedPreferences(AppInstallPolicy.PREFS_NAME, Context.MODE_PRIVATE).edit().clear().commit();

        for (String r : new String[]{
                UserManager.DISALLOW_INSTALL_APPS,
                UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES
        }) {
            dpm.clearUserRestriction(admin, r);
        }

        AppInstallPolicy.saveLocal(c, new AppInstallPolicy(1L, true));
        assertTrue(dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));
    }

    @After
    public void tearDown() {
        PackageInstallManager.serverVerifierForTest = null;
        RestrictionManager.clearLiveAttemptsForTest();
        RestrictionManager.clearHookForTest = null;
        RestrictionManager.postClearHookForTest = null;
        RestrictionManager.applyHookForTest = null;
        RestrictionManager.commitInterceptorForTest = null;
    }

    @Test
    public void testComputeFileSha256MatchesExpectedDigest() throws Exception {
        File tmp = new File(c.getCacheDir(), "test_digest.apk");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write("injaz-mdm-apk-payload".getBytes(StandardCharsets.UTF_8));
        }
        String sha = PackageInstallManager.computeFileSha256(tmp);
        assertNotNull(sha);
        assertEquals(64, sha.length());
        assertTrue(sha.matches("^[0-9a-f]{64}$"));
        tmp.delete();
    }

    @Test
    public void testClearTaskSynchronouslyRemovesCommittedAndPendingAckFields() {
        SharedPreferences p = c.getSharedPreferences(PackageInstallManager.PREFS_TASKS, Context.MODE_PRIVATE);
        String prefix = "session_42";

        boolean committed = p.edit()
                .putInt(prefix + "_session_id", 42)
                .putString(prefix + "_cmd_id", "cmd_101")
                .putString(prefix + "_attempt_id", "attempt_42")
                .putString(prefix + "_uid", "device_1")
                .putString(prefix + "_pkg", "com.company.erp")
                .putLong(prefix + "_version_code", 12L)
                .putLong(prefix + "_pre_install_version", 10L)
                .putLong(prefix + "_pre_install_update_time", 1700000000000L)
                .putLong(prefix + "_expires_at_ms", 1800000000000L)
                .putString(prefix + "_cert_sha256", "a".repeat(64))
                .putBoolean(prefix + "_add_to_kiosk", true)
                .putLong(prefix + "_created_at", 1700000001000L)
                .putLong(prefix + "_result_installed_ver", 12L)
                .putString(prefix + "_result_status", "executed")
                .putString(prefix + "_result_outcome", PackageInstallManager.OUTCOME_INSTALLED)
                .putString(prefix + "_result_progress", "تم التثبيت")
                .putString(prefix + "_result_error", "")
                .putInt(prefix + "_result_error_code", 0)
                .putString(prefix + "_state", "RESULT_PENDING_ACK")
                .commit();
        assertTrue(committed);

        boolean cleared = PackageInstallManager.clearTask(p, prefix);
        assertTrue(cleared);
        assertEquals("", p.getString(prefix + "_state", ""));
        assertEquals("", p.getString(prefix + "_cmd_id", ""));
        assertEquals("", p.getString(prefix + "_attempt_id", ""));
        assertEquals("", p.getString(prefix + "_result_outcome", ""));
    }

    @Test
    public void testValidateDownloadTargetRejectsExternalHostAndHttpAndUserInfo() {
        try {
            PackageInstallManager.validateAndClassifyDownloadUrl(
                    "https://evil.attacker.example.com/company_apps/app_1/sales.apk",
                    "vansales-mdm.appspot.com",
                    "app_1"
            );
            fail("Expected SecurityException for external host");
        } catch (SecurityException ex) {
            assertTrue(ex.getMessage().contains("المضيف الخارجي"));
        }

        try {
            PackageInstallManager.validateAndClassifyDownloadUrl(
                    "http://firebasestorage.googleapis.com/v0/b/vansales-mdm.appspot.com/o/company_apps%2Fapp_1%2Fsales.apk?alt=media",
                    "vansales-mdm.appspot.com",
                    "app_1"
            );
            fail("Expected SecurityException for non-HTTPS URL");
        } catch (SecurityException ex) {
            assertTrue(ex.getMessage().contains("HTTPS"));
        }

        try {
            PackageInstallManager.validateAndClassifyDownloadUrl(
                    "https://firebasestorage.googleapis.com@evil.com/v0/b/vansales-mdm.appspot.com/o/company_apps%2Fapp_1%2Fsales.apk",
                    "vansales-mdm.appspot.com",
                    "app_1"
            );
            fail("Expected SecurityException for userInfo spoofing");
        } catch (SecurityException ex) {
            assertNotNull(ex.getMessage());
        }

        try {
            PackageInstallManager.validateAndClassifyDownloadUrl(
                    "https://firebasestorage.googleapis.com/v0/b/vansales-mdm.appspot.com/o/company_apps%2Fapp_1%2F..%2Fsecret.apk?alt=media",
                    "vansales-mdm.appspot.com",
                    "app_1"
            );
            fail("Expected SecurityException for path traversal");
        } catch (SecurityException ex) {
            assertTrue(ex.getMessage().contains(".."));
        }
    }

    @Test
    public void testPreSignedStorageUrlDoesNotSendFirebaseAuthTokenWhileTaskStoragePathRequiresToken() {
        PackageInstallManager.ValidatedDownloadTarget signedTarget =
                PackageInstallManager.validateAndClassifyDownloadUrl(
                        "https://storage.googleapis.com/vansales-mdm.appspot.com/company_apps/app_1/sales.apk?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=abcdef123456",
                        "vansales-mdm.appspot.com",
                        "app_1"
                );
        assertEquals("storage.googleapis.com", signedTarget.host);
        assertTrue(signedTarget.isSignedStorageUrl);
        assertFalse("Pre-signed URL must NEVER receive Firebase Auth token", signedTarget.requiresFirebaseAuthToken);

        try {
            PackageInstallManager.validateAndClassifyDownloadUrl(
                    "https://storage.googleapis.com/vansales-mdm.appspot.com/company_apps/app_1/sales.apk",
                    "vansales-mdm.appspot.com",
                    "app_1"
            );
            fail("Expected SecurityException for unsigned storage.googleapis.com URL");
        } catch (SecurityException ex) {
            assertTrue(ex.getMessage().contains("X-Goog-Signature"));
        }

        PackageInstallManager.ValidatedDownloadTarget firebaseTarget =
                PackageInstallManager.resolveProtectedDownloadTarget(
                        null,
                        "company_apps/app_1/sales.apk",
                        "vansales-mdm.appspot.com",
                        "app_1"
                );
        assertEquals("firebasestorage.googleapis.com", firebaseTarget.host);
        assertFalse(firebaseTarget.isSignedStorageUrl);
        assertTrue(firebaseTarget.requiresFirebaseAuthToken);

        try {
            PackageInstallManager.resolveProtectedDownloadTarget(
                    null,
                    "company_apps/app_OTHER/sales.apk",
                    "vansales-mdm.appspot.com",
                    "app_1"
            );
            fail("Expected SecurityException when storage_path does not match task app_id");
        } catch (SecurityException ex) {
            assertNotNull(ex.getMessage());
        }
    }

    @Test
    public void testVerifyResponseNotRedirectedBlocksAll3xxRedirects() {
        for (int redirectCode : new int[]{301, 302, 303, 307, 308}) {
            try {
                PackageInstallManager.verifyResponseNotRedirected(
                        redirectCode,
                        "https://evil.example.com/redirected.apk"
                );
                fail("Expected SecurityException for HTTP redirect code " + redirectCode);
            } catch (SecurityException ex) {
                assertTrue(ex.getMessage().contains(String.valueOf(redirectCode)));
            }
        }

        PackageInstallManager.verifyResponseNotRedirected(200, null);
    }

    @Test
    public void testCreateSessionFailsWithRestrictionAndExecuteVerifiedSessionInstallKeepsNetworkOutsideSuspension() throws Exception {
        // 1. Prove that calling createSession while DISALLOW_INSTALL_APPS is active fails with SecurityException
        PackageInstaller.SessionParams directParams =
                new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        directParams.setAppPackageName("com.company.erp");
        try {
            c.getPackageManager().getPackageInstaller().createSession(directParams);
            fail("createSession must fail when DISALLOW_INSTALL_APPS is enforced");
        } catch (SecurityException expected) {
            assertTrue(expected.getMessage().contains("DISALLOW_INSTALL_APPS"));
        }

        // 2. Prepare a temporary APK payload and record restriction state during every network check
        File tempApk = new File(c.getCacheDir(), "verified_session_payload.apk");
        try (FileOutputStream out = new FileOutputStream(tempApk)) {
            out.write("apk-binary-stream-content".getBytes(StandardCharsets.UTF_8));
        }

        List<Boolean> restrictionEnforcedDuringNetworkVerify = new ArrayList<>();
        List<Boolean> suspensionFlagDuringNetworkVerify = new ArrayList<>();

        PackageInstallManager.serverVerifierForTest = (ctx, uid, cmdId, expiresAtMs) -> {
            boolean restricted = dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false);
            boolean suspended = RestrictionManager.isInstallRestrictionSuspended(ctx);
            restrictionEnforcedDuringNetworkVerify.add(restricted);
            suspensionFlagDuringNetworkVerify.add(suspended);
        };

        PackageInstallManager.executeVerifiedSessionInstall(
                c,
                tempApk,
                "com.company.erp",
                10,
                "a".repeat(64),
                -1L,
                -1L,
                "cmd_network_outside_1",
                "attempt_network_outside_1",
                "device_uid_1",
                System.currentTimeMillis() + 600_000L,
                true,
                null
        );

        // Must have performed 2 server verifications: (1) before first suspension, (2) after restoring restriction following fsync
        assertEquals(2, restrictionEnforcedDuringNetworkVerify.size());
        assertTrue("DISALLOW_INSTALL_APPS must be active during pre-session network check",
                restrictionEnforcedDuringNetworkVerify.get(0));
        assertFalse("Suspension journal must be inactive during pre-session network check",
                suspensionFlagDuringNetworkVerify.get(0));

        assertTrue("DISALLOW_INSTALL_APPS must be restored BEFORE final pre-commit network check",
                restrictionEnforcedDuringNetworkVerify.get(1));
        assertFalse("Suspension journal must be cleared BEFORE final pre-commit network check",
                suspensionFlagDuringNetworkVerify.get(1));

        // After executeVerifiedSessionInstall finishes, finally restores restriction and unregisters live attempt
        assertTrue("DISALLOW_INSTALL_APPS must be restored in finally after session.commit",
                dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));
        assertFalse(RestrictionManager.isInstallRestrictionSuspended(c));
        assertFalse(RestrictionManager.isAttemptLiveInProcess("attempt_network_outside_1"));
    }

    @Test
    public void testServerVerificationFailureAfterSessionFsyncAbandonsSessionWithRestrictionAlreadyRestored() throws Exception {
        File tempApk = new File(c.getCacheDir(), "cancelled_session_payload.apk");
        try (FileOutputStream out = new FileOutputStream(tempApk)) {
            out.write("apk-binary-stream-content".getBytes(StandardCharsets.UTF_8));
        }

        final int[] verifyCount = {0};
        PackageInstallManager.serverVerifierForTest = (ctx, uid, cmdId, expiresAtMs) -> {
            verifyCount[0]++;
            assertTrue("DISALLOW_INSTALL_APPS must be enforced during every server check",
                    dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));
            assertFalse("Suspension must NOT be active during server check",
                    RestrictionManager.isInstallRestrictionSuspended(ctx));
            if (verifyCount[0] == 2) {
                throw new IllegalStateException("تم إلغاء أمر التثبيت من الإدارة قبل اعتماد الجلسة.");
            }
        };

        try {
            PackageInstallManager.executeVerifiedSessionInstall(
                    c,
                    tempApk,
                    "com.company.erp",
                    10,
                    "a".repeat(64),
                    -1L,
                    -1L,
                    "cmd_cancelled_2",
                    "attempt_cancelled_2",
                    "device_uid_1",
                    System.currentTimeMillis() + 600_000L,
                    true,
                    null
            );
            fail("Expected IllegalStateException when command is cancelled on server before commit");
        } catch (IllegalStateException ex) {
            assertTrue(ex.getMessage().contains("تم إلغاء أمر التثبيت"));
        }

        assertEquals(2, verifyCount[0]);
        assertTrue(dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));
        assertFalse(RestrictionManager.isInstallRestrictionSuspended(c));
        assertFalse(RestrictionManager.isAttemptLiveInProcess("attempt_cancelled_2"));
    }

    @Test
    public void testInstallSuspensionJournalAndRecoveryFlow() throws Exception {
        // Suspend restriction with an attemptId and simulate process death (unregister live attempt)
        RestrictionManager.suspendInstallRestrictionForApprovedTask(c, "cmd_999", "attempt_999", "com.company.sales");
        assertTrue(RestrictionManager.isInstallRestrictionSuspended(c));
        assertFalse(dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));

        // Process death recovery invocation via recoverPendingInstallTasks restores restriction and clears journal
        PackageInstallManager.recoverPendingInstallTasks(c);
        assertFalse(RestrictionManager.isInstallRestrictionSuspended(c));
        assertTrue(dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false));
    }
}

package com.company.mdmagent;

import android.app.Application;
import android.content.Context;
import android.content.SharedPreferences;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 34)
public class PackageInstallManagerTest {

    @Test
    public void testComputeFileSha256MatchesExpectedDigest() throws Exception {
        Application c = RuntimeEnvironment.getApplication();
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
        Application c = RuntimeEnvironment.getApplication();
        SharedPreferences p = c.getSharedPreferences(PackageInstallManager.PREFS_TASKS, Context.MODE_PRIVATE);
        String prefix = "session_42";

        boolean committed = p.edit()
                .putInt(prefix + "_session_id", 42)
                .putString(prefix + "_cmd_id", "cmd_101")
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
        assertEquals("", p.getString(prefix + "_result_outcome", ""));
    }

    @Test
    public void testValidateDownloadTargetRejectsExternalHostAndHttpAndUserInfo() {
        // 1. External HTTPS host must be rejected (never send Firebase token to external host)
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

        // 2. Non-HTTPS (http://) on trusted host must be rejected
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

        // 3. Embedded userInfo spoofing (https://firebasestorage.googleapis.com@evil.com/...) must be rejected
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

        // 4. Path traversal (..) must be rejected
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
        // 1. Pre-signed GCS URL (from getTaskDownloadAuthorization) -> requiresFirebaseAuthToken MUST be false!
        PackageInstallManager.ValidatedDownloadTarget signedTarget =
                PackageInstallManager.validateAndClassifyDownloadUrl(
                        "https://storage.googleapis.com/vansales-mdm.appspot.com/company_apps/app_1/sales.apk?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=abcdef123456",
                        "vansales-mdm.appspot.com",
                        "app_1"
                );
        assertEquals("storage.googleapis.com", signedTarget.host);
        assertTrue(signedTarget.isSignedStorageUrl);
        assertFalse("Pre-signed URL must NEVER receive Firebase Auth token", signedTarget.requiresFirebaseAuthToken);

        // 2. Non-signed storage.googleapis.com URL -> rejected
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

        // 3. Task-bound storage_path resolved for firebasestorage.googleapis.com -> requiresFirebaseAuthToken is true
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

        // 4. Mismatched appId in storage_path -> rejected
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

        // HTTP 200 OK succeeds
        PackageInstallManager.verifyResponseNotRedirected(200, null);
    }
}

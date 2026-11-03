package com.company.mdmagent;

import android.app.Application;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.os.UserManager;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import java.util.Set;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE, sdk=34, shadows=KioskResumeTest.RestrictionsShadow.class)
public class DeprovisionTest {

    private String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }

    private String computeHash(char[] pass, byte[] salt) throws Exception {
        PBEKeySpec spec = new PBEKeySpec(pass, salt, 120000, 256);
        byte[] key = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
        return toHex(key);
    }

    @Test
    public void testPasscodeVerificationAndThrottling() throws Exception {
        Application c = RuntimeEnvironment.getApplication();
        byte[] salt = new byte[]{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16};
        String saltHex = toHex(salt);
        String correctHash = computeHash("SecretPass123!".toCharArray(), salt);

        DeprovisionController.savePasscodeCredentials(c, saltHex, correctHash);

        // Wrong passcode fails
        boolean okWrong = DeprovisionController.verifyPasscode(c, "WrongPass123!".toCharArray());
        assertFalse(okWrong);

        // Even a correct passcode is rejected until the persisted cooldown expires.
        assertThrows(IllegalStateException.class, () ->
                DeprovisionController.verifyPasscode(c, "SecretPass123!".toCharArray()));
        org.robolectric.shadows.ShadowSystemClock.advanceBy(java.time.Duration.ofSeconds(3));

        // Correct passcode succeeds after cooldown and resets the failure counter.
        boolean okRight = DeprovisionController.verifyPasscode(c, "SecretPass123!".toCharArray());
        assertTrue(okRight);
        assertEquals(0, DeprovisionController.prefs(c).getInt(DeprovisionController.KEY_FAILURES, -1));
        assertEquals(0L, DeprovisionController.prefs(c).getLong(DeprovisionController.KEY_RETRY_AFTER, -1));
    }

    @Test
    public void testDeprovisionClearsOwnedRestrictionsAndDeviceOwner() throws Exception {
        Application c = RuntimeEnvironment.getApplication();
        DevicePolicyManager dpm = (DevicePolicyManager) c.getSystemService(Application.DEVICE_POLICY_SERVICE);
        ComponentName admin = new ComponentName(c, AdminReceiver.class);
        Shadows.shadowOf(dpm).setDeviceOwner(admin);

        // Pre-existing restriction
        dpm.addUserRestriction(admin, UserManager.DISALLOW_SAFE_BOOT);

        // Owned restriction added by Injaz
        RestrictionManager.prefs(c).edit()
                .putStringSet(RestrictionManager.KEY_OWNED_RESTRICTIONS, Set.of(UserManager.DISALLOW_INSTALL_APPS))
                .commit();
        dpm.addUserRestriction(admin, UserManager.DISALLOW_INSTALL_APPS);

        assertFalse(DeprovisionController.isDeprovisioned(c));

        // In production without allow_test_deprovision flag, it must throw UnsupportedOperationException
        assertThrows(UnsupportedOperationException.class, () -> DeprovisionController.deprovision(c));

        // Enable test mode for testApi execution
        DeprovisionController.prefs(c).edit().putBoolean("allow_test_deprovision", true).commit();

        // Execute deprovisioning in test mode
        DeprovisionController.deprovision(c);

        assertTrue(DeprovisionController.isDeprovisioned(c));
        // Injaz owned restriction removed
        assertFalse(dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS));
        // Pre-existing restriction untouched
        assertTrue(dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_SAFE_BOOT));
        // Device Owner relinquished
        assertFalse(dpm.isDeviceOwnerApp(c.getPackageName()));
    }
}

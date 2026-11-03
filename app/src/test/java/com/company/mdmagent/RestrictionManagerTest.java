package com.company.mdmagent;

import android.os.UserManager;
import org.junit.Test;
import java.util.Set;
import static org.junit.Assert.*;

public class RestrictionManagerTest {

    @Test
    public void testInstallPolicyPreservesRestrictionsWhenKioskDisabled() {
        // When kiosk is inactive/disabled, but blockAppInstalls is true:
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
        // State 1: Both Kiosk and Independent Install blocking are enabled
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

        // State 2: Manager enters maintenance mode offline or kiosk disabled remotely (kioskActiveAndEnabled = false)
        // BUT independent install policy is STILL active (blockAppInstalls = true)
        Set<String> maintenanceSuite = RestrictionManager.computeRequiredRestrictions(
                null,
                false, // kiosk disabled or in maintenance
                true,  // independent install STILL blocked
                true,  // tethering STILL blocked
                false
        );

        // Crucial guarantee: install blocking MUST remain active!
        assertTrue("DISALLOW_INSTALL_APPS must remain active during maintenance",
                maintenanceSuite.contains(UserManager.DISALLOW_INSTALL_APPS));
        assertTrue("DISALLOW_INSTALL_UNKNOWN_SOURCES must remain active during maintenance",
                maintenanceSuite.contains(UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES));
        assertTrue("DISALLOW_CONFIG_TETHERING must remain active during maintenance",
                maintenanceSuite.contains(UserManager.DISALLOW_CONFIG_TETHERING));

        // Kiosk-specific restrictions are lifted
        assertFalse("DISALLOW_UNINSTALL_APPS should be lifted",
                maintenanceSuite.contains(UserManager.DISALLOW_UNINSTALL_APPS));
        assertFalse("DISALLOW_SAFE_BOOT should be lifted",
                maintenanceSuite.contains(UserManager.DISALLOW_SAFE_BOOT));
        assertFalse("DISALLOW_ADD_USER should be lifted",
                maintenanceSuite.contains(UserManager.DISALLOW_ADD_USER));
    }
}

package com.company.mdmagent;
import android.app.Application;
import android.app.admin.DevicePolicyManager;
import android.content.*;
import android.os.UserManager;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import java.util.*;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=34)
public class KioskRecoveryTest {
 @Test public void disablingKioskPreservesTetheringAndPreexistingRestrictions(){
  Application c=RuntimeEnvironment.getApplication();DevicePolicyManager d=KioskController.dpm(c);ComponentName a=KioskController.admin(c);
  Shadows.shadowOf(d).setDeviceOwner(a);
  d.addUserRestriction(a,UserManager.DISALLOW_CONFIG_TETHERING);
  d.addUserRestriction(a,UserManager.DISALLOW_SAFE_BOOT);
  d.addUserRestriction(a,UserManager.DISALLOW_INSTALL_APPS);
  KioskController.prefs(c).edit().putBoolean("managed",true).putBoolean("enabled",true)
    .putStringSet("owned_restrictions",Set.of(UserManager.DISALLOW_INSTALL_APPS)).commit();
  KioskController.disable(c);
  assertFalse(KioskController.enabled(c));
  assertFalse(d.getUserRestrictions(a).getBoolean(UserManager.DISALLOW_INSTALL_APPS));
  assertTrue(d.getUserRestrictions(a).getBoolean(UserManager.DISALLOW_CONFIG_TETHERING));
  assertTrue(d.getUserRestrictions(a).getBoolean(UserManager.DISALLOW_SAFE_BOOT));
 }
 @Test public void missingTargetDoesNotActivateKioskOrRestrictInstallation() throws Exception {
  Application c=RuntimeEnvironment.getApplication();DevicePolicyManager d=KioskController.dpm(c);Shadows.shadowOf(d).setDeviceOwner(KioskController.admin(c));
  KioskPolicy p=new KioskPolicy(1,true,Set.of("com.missing.app"),"a".repeat(32),"b".repeat(64));
  assertThrows(IllegalArgumentException.class,()->KioskController.apply(c,p));
  assertFalse(KioskController.enabled(c));assertFalse(d.getUserRestrictions(KioskController.admin(c)).getBoolean(UserManager.DISALLOW_INSTALL_APPS));
 }
}

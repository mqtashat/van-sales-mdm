package com.company.mdmagent;

import android.app.*;
import android.app.admin.DevicePolicyManager;
import android.content.*;
import android.content.pm.*;
import android.os.UserManager;
import android.os.Bundle;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadows.ShadowDevicePolicyManager;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import java.util.*;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=34,shadows=KioskResumeTest.RestrictionsShadow.class)
public class KioskResumeTest {
    // Robolectric 4.14 writes DPM restrictions into ShadowUserManager but does not implement
    // DPM.getUserRestrictions. Bridge that read to the actual state recorded by its add/clear APIs.
    @Implements(DevicePolicyManager.class)
    public static class RestrictionsShadow extends ShadowDevicePolicyManager {
        @Implementation protected Bundle getUserRestrictions(ComponentName admin) {
            return ((UserManager)RuntimeEnvironment.getApplication().getSystemService(Context.USER_SERVICE)).getUserRestrictions();
        }
    }
    Application c; DevicePolicyManager d; ComponentName admin;
    final String pkg="com.company.salesapp";
    @Before public void setup(){
        c=RuntimeEnvironment.getApplication();d=KioskController.dpm(c);admin=KioskController.admin(c);
        Shadows.shadowOf(d).setDeviceOwner(admin);
        SyncEngine.recordApprovalState(c.getSharedPreferences(SyncEngine.PREFS_NAME,0),"uid1",true);
        ApplicationInfo ai=new ApplicationInfo();ai.packageName=pkg;ai.enabled=true;ai.flags=ApplicationInfo.FLAG_INSTALLED;
        ActivityInfo activity=new ActivityInfo();activity.packageName=pkg;activity.name=pkg+".Main";activity.applicationInfo=ai;activity.enabled=true;
        PackageInfo installed=new PackageInfo();installed.packageName=pkg;installed.applicationInfo=ai;installed.activities=new ActivityInfo[]{activity};
        Shadows.shadowOf(c.getPackageManager()).installPackage(installed);
        ResolveInfo resolve=new ResolveInfo();resolve.activityInfo=activity;
        Shadows.shadowOf(c.getPackageManager()).addResolveInfoForIntent(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setPackage(pkg),resolve);
        assertNotNull("Fixture must register an installed launcher app",c.getPackageManager().getLaunchIntentForPackage(pkg));
    }
    @After public void cleanup(){RestrictionManager.clearHookForTest=null;}
    KioskPolicy policy(long rev,boolean enabled){return new KioskPolicy(rev,enabled,Set.of(pkg),"a".repeat(32),"b".repeat(64));}
    void legacyMaintenance(){
        KioskController.prefs(c).edit().putLong("accepted_revision",7).putLong("configured_revision",7)
            .putLong("recovery_revision",7).putBoolean("enabled",false).putStringSet("apps",Set.of(pkg))
            .putString("exit_salt","a".repeat(32)).putString("exit_hash","b".repeat(64)).commit();
        c.getPackageManager().setComponentEnabledSetting(new ComponentName(c,KioskActivity.class),PackageManager.COMPONENT_ENABLED_STATE_DISABLED,PackageManager.DONT_KILL_APP);
    }
    @Test public void legacySameRevisionRefreshThenOfflineResumePreservesOtherPolicies()throws Exception{
        legacyMaintenance();
        assertThrows(IllegalStateException.class,()->KioskController.resumeMaintenance(c,"uid1"));
        KioskController.apply(c,policy(7,true));
        assertTrue(KioskController.inMaintenance(c));assertFalse(KioskController.enabled(c));
        d.addUserRestriction(admin,UserManager.DISALLOW_CONFIG_TETHERING);
        c.getSharedPreferences(SyncEngine.PREFS_NAME,0).edit().putStringSet("hidden_by_agent",Set.of("com.example.hidden")).commit();
        KioskController.resumeMaintenance(c,"uid1"); // entirely local: no Firebase initialization/network
        assertFalse(KioskController.inMaintenance(c));assertTrue(KioskController.enabled(c));
        assertEquals(PackageManager.COMPONENT_ENABLED_STATE_ENABLED,c.getPackageManager().getComponentEnabledSetting(new ComponentName(c,KioskActivity.class)));
        for(String r:KioskController.RESTRICTIONS)assertTrue(d.getUserRestrictions(admin).getBoolean(r));
        assertTrue(d.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_CONFIG_TETHERING));
        assertEquals(Set.of("com.example.hidden"),c.getSharedPreferences(SyncEngine.PREFS_NAME,0).getStringSet("hidden_by_agent",Set.of()));
        KioskController.resumeMaintenance(c,"uid1"); // repeated press is harmless
        assertEquals(7,KioskController.prefs(c).getLong("accepted_revision",0));
    }
    @Test public void sameRevisionKeepsMaintenanceNewRevisionResumesAndDisabledPolicyCannotResume()throws Exception{
        legacyMaintenance();KioskController.apply(c,policy(7,true));assertTrue(KioskController.inMaintenance(c));
        KioskController.apply(c,policy(8,true));assertFalse(KioskController.inMaintenance(c));
        assertEquals(7,KioskController.prefs(c).getLong("configured_revision",0)); // awaiting actual lock
        KioskController.apply(c,policy(9,false));assertFalse(KioskController.enabled(c));
        assertThrows(IllegalStateException.class,()->KioskController.resumeMaintenance(c,"uid1"));
        assertThrows(IllegalArgumentException.class,()->KioskController.apply(c,policy(8,true)));
    }
    @Test public void failedResumeRetainsMaintenanceAndCredential()throws Exception{
        legacyMaintenance();KioskController.apply(c,policy(7,true));
        Shadows.shadowOf(d).setDeviceOwner(null);
        assertFalse(d.isDeviceOwnerApp(c.getPackageName()));
        assertThrows(IllegalStateException.class,()->KioskController.resumeMaintenance(c,"uid1"));
        assertTrue(KioskController.inMaintenance(c));assertEquals("b".repeat(64),KioskController.prefs(c).getString("exit_hash",""));
        assertFalse(KioskController.prefs(c).getString("last_error","").isEmpty());
        Shadows.shadowOf(d).setDeviceOwner(admin);
        KioskController.resumeMaintenance(c,"uid1");assertTrue(KioskController.enabled(c));
    }
    @Test public void partialReleaseKeepsFailedRestrictionAndRetriesWithoutFalseSuccess()throws Exception{
        KioskController.apply(c,policy(7,true));
        KioskController.prefs(c).edit().putLong("configured_revision",7).commit();
        RestrictionManager.clearHookForTest=r->{if(r.equals(UserManager.DISALLOW_SAFE_BOOT))throw new SecurityException();};
        assertThrows(IllegalStateException.class,()->KioskController.apply(c,policy(8,false)));
        assertEquals(7,KioskController.prefs(c).getLong("configured_revision",0));
        assertEquals(Set.of(UserManager.DISALLOW_SAFE_BOOT),KioskController.prefs(c).getStringSet("owned_restrictions",Set.of()));
        assertTrue(KioskController.prefs(c).getString("last_error","").contains("SecurityException"));
        RestrictionManager.clearHookForTest=null;KioskController.apply(c,policy(8,false));
        assertEquals(8,KioskController.prefs(c).getLong("configured_revision",0));
        assertEquals("",KioskController.prefs(c).getString("last_error",""));
        assertTrue(KioskController.prefs(c).getStringSet("owned_restrictions",Set.of()).isEmpty());
    }
    @Test public void unconfirmedLockDoesNotAdvanceRevisionAndNamePersists()throws Exception{
        KioskController.apply(c,policy(8,true));
        assertThrows(IllegalStateException.class,()->KioskController.confirmLocked(c));
        assertEquals(0,KioskController.prefs(c).getLong("configured_revision",0));
        KioskController.cacheDeviceName(c,"موظف عمان");assertEquals("موظف عمان",KioskController.deviceName(c));
        KioskController.cacheDeviceName(c,"");assertEquals("جهاز الشركة",KioskController.deviceName(c));
    }
}

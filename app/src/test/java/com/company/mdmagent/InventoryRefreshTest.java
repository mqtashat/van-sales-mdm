package com.company.mdmagent;

import android.content.*;
import android.content.pm.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=34)
public class InventoryRefreshTest {
    @Test public void packageEventsMarkInventoryDirtyEvenWithoutActiveManagement() {
        Context c=RuntimeEnvironment.getApplication();
        c.getSharedPreferences("inventory-state",0).edit().clear().commit();
        new AppChangeReceiver().onReceive(c,new Intent(Intent.ACTION_PACKAGE_ADDED,android.net.Uri.parse("package:com.whatsapp")));
        assertTrue(c.getSharedPreferences("inventory-state",0).getBoolean("dirty",false));
    }
    @Test public void launcherDiscoveryUsesDeclaredComponentsWithoutOpeningApp() {
        Context c=RuntimeEnvironment.getApplication();
        PackageManager pm=c.getPackageManager();
        Intent launcher=new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setPackage("com.example.work");
        ResolveInfo found=new ResolveInfo();found.activityInfo=new ActivityInfo();found.activityInfo.packageName="com.example.work";found.activityInfo.name="com.example.work.Main";
        Shadows.shadowOf(pm).addResolveInfoForIntent(launcher,found);
        assertTrue(DeviceInventory.hasLauncher(pm,"com.example.work"));
        assertFalse(DeviceInventory.hasLauncher(pm,"com.example.absent"));
    }
    @Test public void orderedAppsIgnoreUnapprovedAndDuplicateEntries() {
        Context c=RuntimeEnvironment.getApplication();
        KioskController.prefs(c).edit().clear().putStringSet("apps",new java.util.HashSet<>(java.util.Arrays.asList("com.b.app","com.a.app")))
                .putString("apps_order","[\"com.b.app\",\"com.evil.app\",\"com.b.app\",\"com.a.app\"]").commit();
        assertEquals(java.util.Arrays.asList("com.b.app","com.a.app"),KioskController.orderedApps(c));
    }
}

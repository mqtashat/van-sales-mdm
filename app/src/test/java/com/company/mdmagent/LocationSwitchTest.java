package com.company.mdmagent;

import android.content.Context;
import android.location.LocationManager;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE, sdk={26,28})
public class LocationSwitchTest {
    @Test public void readsLocationSwitchOnSupportedAndroidVersions() {
        LocationManager manager = (LocationManager) RuntimeEnvironment.getApplication()
                .getSystemService(Context.LOCATION_SERVICE);
        assertFalse(SyncEngine.isLocationSwitchEnabled(null));
        Shadows.shadowOf(manager).setProviderEnabled(LocationManager.GPS_PROVIDER, false);
        Shadows.shadowOf(manager).setProviderEnabled(LocationManager.NETWORK_PROVIDER, false);
        assertFalse(SyncEngine.isLocationSwitchEnabled(manager));
        Shadows.shadowOf(manager).setProviderEnabled(LocationManager.GPS_PROVIDER, true);
        assertTrue(SyncEngine.isLocationSwitchEnabled(manager));
        Shadows.shadowOf(manager).setProviderEnabled(LocationManager.GPS_PROVIDER, false);
        Shadows.shadowOf(manager).setProviderEnabled(LocationManager.NETWORK_PROVIDER, true);
        assertTrue(SyncEngine.isLocationSwitchEnabled(manager));
    }
}

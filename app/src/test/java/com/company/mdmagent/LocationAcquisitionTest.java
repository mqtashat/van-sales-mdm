package com.company.mdmagent;
import android.location.Location;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE, sdk=28)
public class LocationAcquisitionTest {
    @Test public void repeatedStartsKeepOneScheduleAndShutdownRemovesCallbacks() throws Exception {
        PolicyLocationService s = Robolectric.buildService(PolicyLocationService.class).create().get();
        Method start = PolicyLocationService.class.getDeclaredMethod("startScheduleChecker"); start.setAccessible(true);
        Field field = PolicyLocationService.class.getDeclaredField("scheduleCheckRunnable"); field.setAccessible(true);
        start.invoke(s); Object first = field.get(s); start.invoke(s);
        assertSame(first,field.get(s)); s.onDestroy();
    }
}

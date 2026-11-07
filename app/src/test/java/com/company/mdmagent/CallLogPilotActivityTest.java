package com.company.mdmagent;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, application = android.app.Application.class)
public class CallLogPilotActivityTest {
    @Test public void rejectsEntryWithoutDeviceOwnerAndMaintenance() {
        // canAccess must fail before Firebase is needed when the app is not Device Owner.
        CallLogPilotActivity a = Robolectric.buildActivity(CallLogPilotActivity.class).create().get();
        assertTrue(a.isFinishing());
    }
}

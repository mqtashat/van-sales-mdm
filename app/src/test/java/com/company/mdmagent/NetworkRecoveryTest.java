package com.company.mdmagent;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeoutException;
import com.google.firebase.firestore.FirebaseFirestoreException;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 28)
public class NetworkRecoveryTest {
    @Test public void wanRestorationOnSameWifiRequestsSyncOnce() {
        NetworkRecoveryState state = new NetworkRecoveryState();
        state.available("wifi");
        assertFalse(state.capabilities("wifi", false));
        assertTrue(state.capabilities("wifi", true));
        assertFalse(state.capabilities("wifi", true));
        assertFalse(state.capabilities("wifi", false));
        assertTrue(state.capabilities("wifi", true));
        assertFalse(state.capabilities("wifi", true));
    }

    @Test public void oldNetworkCallbacksCannotInvalidateNewDefault() {
        NetworkRecoveryState state = new NetworkRecoveryState();
        state.available("wifi");
        assertTrue(state.capabilities("wifi", true));
        state.available("mobile");
        state.lost("wifi");
        assertFalse(state.capabilities("wifi", true));
        assertTrue(state.capabilities("mobile", true));
        state.lost("mobile");
        state.available("wifi");
        assertTrue(state.capabilities("wifi", true));
    }

    @Test public void transientFailuresRetryButStopAtBudget() {
        Exception error = new ExecutionException(new TimeoutException());
        assertTrue(SyncRecovery.shouldRetry(error, 0));
        assertTrue(SyncRecovery.shouldRetry(error, 2));
        assertFalse(SyncRecovery.shouldRetry(error, 3));
        assertTrue(SyncRecovery.isTransient(new ExecutionException(new FirebaseFirestoreException(
                "offline", FirebaseFirestoreException.Code.UNAVAILABLE))));
    }

    @Test public void permanentFailuresDoNotRetry() {
        assertFalse(SyncRecovery.isTransient(new IllegalArgumentException("bad policy")));
        assertFalse(SyncRecovery.isTransient(new FirebaseFirestoreException(
                "denied", FirebaseFirestoreException.Code.PERMISSION_DENIED)));
        assertFalse(SyncRecovery.isTransient(new FirebaseFirestoreException(
                "unauthenticated", FirebaseFirestoreException.Code.UNAUTHENTICATED)));
    }
}

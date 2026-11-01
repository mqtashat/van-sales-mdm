package com.company.mdmagent;

import android.content.Context;
import android.util.Log;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import com.google.firebase.firestore.FirebaseFirestoreException;
import java.io.IOException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** Durable, bounded retries; malformed policies and permission failures are not retried. */
final class SyncRecovery {
    static boolean isTransient(Throwable error) {
        for (int depth = 0; error != null && depth < 10; depth++, error = error.getCause()) {
            if (error instanceof TimeoutException || error instanceof IOException) return true;
            if (error instanceof FirebaseFirestoreException) {
                FirebaseFirestoreException.Code code = ((FirebaseFirestoreException) error).getCode();
                return code == FirebaseFirestoreException.Code.UNAVAILABLE
                        || code == FirebaseFirestoreException.Code.DEADLINE_EXCEEDED
                        || code == FirebaseFirestoreException.Code.ABORTED;
            }
        }
        return false;
    }

    static boolean shouldRetry(Throwable error, int attempt) {
        return attempt < 3 && isTransient(error);
    }

    static void schedule(Context context, Throwable error) {
        if (!isTransient(error)) return;
        try {
            OneTimeWorkRequest work = new OneTimeWorkRequest.Builder(SyncWorker.class)
                    .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                    .setInitialDelay(30, TimeUnit.SECONDS)
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                    .build();
            WorkManager.getInstance(context).enqueueUniqueWork("policy-network-recovery", ExistingWorkPolicy.KEEP, work);
            Log.i(SyncEngine.TAG, "sync_retry_scheduled: minimumDelaySeconds=30; execution subject to Android scheduling");
        } catch (RuntimeException ex) {
            Log.w(SyncEngine.TAG, "sync_retry_schedule_failed: " + ex.getClass().getSimpleName());
        }
    }
}

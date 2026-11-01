package com.company.mdmagent;

import android.content.Context;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

public class SyncWorker extends Worker {
    private static final String TAG = "InjazMdmAgent";

    public SyncWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context appContext = getApplicationContext();
        int attempt = getRunAttemptCount();
        Log.i(TAG, "workmanager_sync_start: attempt=" + attempt + " fgsRunning=" + PolicySyncService.isRunning());
        try {
            SyncEngine.sync(appContext, "workmanager_attempt_" + attempt);
            PolicySyncService.ensureStartedAfterVerifiedSync(appContext, "workmanager_recovery");
            Log.i(TAG, "workmanager_sync_success: attempt=" + attempt);
            return Result.success();
        } catch (Exception ex) {
            Log.w(TAG, "workmanager_sync_failed: attempt=" + attempt
                    + " type=" + ex.getClass().getSimpleName()
                    + " message=" + String.valueOf(ex.getMessage()));
            return SyncRecovery.shouldRetry(ex, attempt) ? Result.retry() : Result.failure();
        }
    }
}


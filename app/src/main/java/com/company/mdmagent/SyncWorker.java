package com.company.mdmagent;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

public class SyncWorker extends Worker {
    public SyncWorker(@NonNull Context context, @NonNull WorkerParameters params) { super(context, params); }
    @NonNull @Override public Result doWork() {
        try {
            SyncEngine.sync(getApplicationContext());
            return Result.success();
        } catch (Exception ex) {
            return getRunAttemptCount() < 3 ? Result.retry() : Result.failure();
        }
    }
}

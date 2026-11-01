package com.company.mdmagent;

import android.app.Application;
import android.content.Context;
import android.util.Log;
import com.google.firebase.auth.FirebaseAuth;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

public class AgentApp extends Application {
    static final String TAG = "InjazMdmAgent";
    static final String PERIODIC_WORK_NAME = "policy-sync";
    static final String ONETIME_WORK_NAME = "policy-sync-immediate";
    static final ExecutorService SYNC = Executors.newSingleThreadExecutor();

    @Override
    public void onCreate() {
        super.onCreate();
        schedulePeriodicSync(this);
        // Restore after Firebase has loaded its persisted identity, not only at BOOT_COMPLETED.
        // The same path also runs when FCM cold-starts this process. No anonymous account is created here.
        FirebaseAuth.getInstance().addAuthStateListener(auth -> {
            if (auth.getCurrentUser() != null && PolicySyncService.canRunForegroundService(this)) {
                PolicySyncService.ensureStarted(this, "auth_restored");
            }
        });
    }

    static void schedulePeriodicSync(Context context) {
        Constraints online = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(SyncWorker.class, 15, TimeUnit.MINUTES)
                .setConstraints(online)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                PERIODIC_WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request
        );
        Log.i(TAG, "workmanager_periodic_scheduled: name=" + PERIODIC_WORK_NAME);
    }

    static void enqueueOneTimeBackupSync(Context context, String reason) {
        Constraints online = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(SyncWorker.class)
                .setConstraints(online)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build();
        WorkManager.getInstance(context).enqueueUniqueWork(
                ONETIME_WORK_NAME,
                ExistingWorkPolicy.KEEP,
                request
        );
        Log.i(TAG, "workmanager_onetime_enqueued: reason=" + reason);
    }
}


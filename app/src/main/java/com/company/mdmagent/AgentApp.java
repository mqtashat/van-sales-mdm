package com.company.mdmagent;

import android.app.Application;
import androidx.work.*;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;

public class AgentApp extends Application {
    static final ExecutorService SYNC = Executors.newSingleThreadExecutor();

    @Override public void onCreate() {
        super.onCreate();
        Constraints online = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(SyncWorker.class, 15, TimeUnit.MINUTES)
                .setConstraints(online).build();
        WorkManager.getInstance(this).enqueueUniquePeriodicWork("policy-sync", ExistingPeriodicWorkPolicy.KEEP, request);
    }
}

package com.company.mdmagent;

import android.app.admin.DeviceAdminReceiver;
import android.content.Context;
import android.content.Intent;
import androidx.work.*;

public class AdminReceiver extends DeviceAdminReceiver {
    @Override public void onEnabled(Context context, Intent intent) {
        WorkManager.getInstance(context).enqueue(new OneTimeWorkRequest.Builder(SyncWorker.class).build());
    }
}

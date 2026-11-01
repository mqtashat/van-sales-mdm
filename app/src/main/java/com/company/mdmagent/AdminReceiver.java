package com.company.mdmagent;

import android.app.admin.DeviceAdminReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

public class AdminReceiver extends DeviceAdminReceiver {
    private static final String TAG = "InjazMdmAgent";

    @Override
    public void onEnabled(Context context, Intent intent) {
        Log.i(TAG, "admin_receiver_enabled: Device admin / owner enabled");
        AgentApp.schedulePeriodicSync(context);
        AgentApp.enqueueOneTimeBackupSync(context, "device_admin_enabled");
        if (PolicySyncService.canRunForegroundService(context)) {
            PolicySyncService.ensureStarted(context, "device_admin_enabled");
        }
    }
}

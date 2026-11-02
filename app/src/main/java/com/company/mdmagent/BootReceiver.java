package com.company.mdmagent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Restores the Device Owner policy sync service after device reboot or package update
 * within Android background execution limits, while keeping WorkManager as a fallback path.
 */
public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "InjazMdmAgent";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return;
        }
        String trigger = Intent.ACTION_BOOT_COMPLETED.equals(action) ? "boot_completed" : "package_replaced";
        Log.i(TAG, "boot_receiver: action=" + trigger + " (" + PolicySyncService.describeEligibility(context) + ")");

        if (KioskController.enabled(context)) KioskController.open(context);

        // Ensure periodic backup worker and a one-time connected backup worker are scheduled
        AgentApp.schedulePeriodicSync(context);
        AgentApp.enqueueOneTimeBackupSync(context, trigger);

        // Attempt to start the foreground service if Device Owner + Firebase identity + server approval are verified
        if (PolicySyncService.canRunForegroundService(context)) {
            PolicySyncService.ensureStarted(context, trigger);
        }
    }
}


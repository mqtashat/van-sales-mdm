package com.company.mdmagent;
import android.content.*;
public class AppChangeReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c,Intent i){
        if(i==null || !java.util.Arrays.asList(Intent.ACTION_PACKAGE_ADDED,Intent.ACTION_PACKAGE_REMOVED,Intent.ACTION_PACKAGE_CHANGED,Intent.ACTION_PACKAGE_REPLACED).contains(i.getAction()))return;
        if (i.getData() != null && c.getPackageName().equals(i.getData().getSchemeSpecificPart())) return;
        DeviceInventory.markDirty(c);
        if(PolicySyncService.isDeviceOwnerActive(c) && PolicySyncService.canRunForegroundService(c)){
            AgentApp.enqueueOneTimeBackupSync(c,"app_inventory_changed");
            SyncEngine.requestSync(c,"app_inventory_changed");
        }
    }
}

package com.company.mdmagent;

import android.app.admin.DevicePolicyManager;
import android.content.*;
import android.content.pm.*;
import android.os.Process;
import com.google.android.gms.tasks.Tasks;
import com.google.firebase.firestore.*;
import java.util.*;
import java.util.concurrent.TimeUnit;

final class DeviceInventory {
    static List<Map<String,Object>> scan(Context c) {
        PackageManager pm = c.getPackageManager();
        DevicePolicyManager dpm = (DevicePolicyManager)c.getSystemService(Context.DEVICE_POLICY_SERVICE);
        ComponentName admin = new ComponentName(c, AdminReceiver.class);
        Set<String> protectedApps = AppRestrictions.protectedPackages(c, dpm);
        Set<String> tracked = c.getSharedPreferences(SyncEngine.PREFS_NAME,0).getStringSet("hidden_by_agent", Collections.emptySet());
        TreeMap<String,ApplicationInfo> found = new TreeMap<>();
        for (ApplicationInfo info : pm.getInstalledApplications(0)) found.put(info.packageName,info);
        for(String pkg : tracked) {
            try { found.put(pkg,pm.getApplicationInfo(pkg,PackageManager.MATCH_UNINSTALLED_PACKAGES)); }
            catch(PackageManager.NameNotFoundException ignored) { /* Actually removed; do not invent an installed app. */ }
        }
        List<Map<String,Object>> apps = new ArrayList<>();
        for(ApplicationInfo info:found.values()) {
            String pkg=info.packageName;
            if (!pkg.contains(".")) continue;
            boolean hidden=dpm.isApplicationHidden(admin,pkg);
            boolean launch=pm.getLaunchIntentForPackage(pkg)!=null;
            boolean system=(info.flags&(ApplicationInfo.FLAG_SYSTEM|ApplicationInfo.FLAG_UPDATED_SYSTEM_APP))!=0;
            // Inventory of user-facing apps, including disabled and agent-hidden apps; not every OS service.
            if(system && !launch && !tracked.contains(pkg)) continue;
            String protection=AppRestrictions.classify(protectedApps.contains(pkg),info.uid%100000<Process.FIRST_APPLICATION_UID,
                    pm.checkSignatures("android",pkg)==PackageManager.SIGNATURE_MATCH,
                    (info.flags&ApplicationInfo.FLAG_PERSISTENT)!=0,system,launch,tracked.contains(pkg));
            Map<String,Object> row=new HashMap<>();
            row.put("package_name",pkg); String label=String.valueOf(pm.getApplicationLabel(info));
            row.put("app_name",label.substring(0,Math.min(120,label.length())));
            row.put("has_launcher_icon",launch);row.put("is_system_app",system);
            row.put("is_protected",protection!=null);row.put("protection_reason",protection==null?"":protection);
            row.put("is_hidden_by_agent",hidden&&tracked.contains(pkg));row.put("is_enabled",info.enabled);
            apps.add(row);
        }
        if(apps.size()>1000) throw new IllegalStateException("Inventory exceeds 1000 apps; not uploaded partially");
        return apps;
    }
    static void publish(Context c, FirebaseFirestore db, String uid) throws Exception {
        List<Map<String,Object>> apps=scan(c);
        String digest=apps.toString();
        SharedPreferences p=c.getSharedPreferences("inventory-state",0);
        long now=System.currentTimeMillis();
        if(uid.equals(p.getString("uid","")) && digest.equals(p.getString("digest","")) && now-p.getLong("at",0)<3600000) return;
        Map<String,Object> doc=new HashMap<>();
        doc.put("schema_version",1L);doc.put("batch_id","single");doc.put("batch_index",0L);doc.put("total_batches",1L);
        doc.put("reported_at",FieldValue.serverTimestamp());doc.put("agent_version",SyncEngine.AGENT_VERSION);doc.put("apps",apps);
        Tasks.await(db.collection("deviceAppInventory").document(uid).set(doc),25,TimeUnit.SECONDS);
        p.edit().putString("uid",uid).putString("digest",digest).putLong("at",now).apply();
    }
}

package com.company.mdmagent;

import android.app.*;
import android.app.admin.DevicePolicyManager;
import android.content.*;
import android.content.pm.PackageManager;
import android.os.*;
import com.google.android.gms.tasks.Tasks;
import com.google.firebase.firestore.*;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.security.MessageDigest;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

final class KioskController {
    static final java.util.concurrent.ExecutorService LOCAL = java.util.concurrent.Executors.newSingleThreadExecutor();
    static final String PREFS="injaz-kiosk";
    static final String[] RESTRICTIONS={UserManager.DISALLOW_INSTALL_APPS,UserManager.DISALLOW_UNINSTALL_APPS,UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES,
            UserManager.DISALLOW_SAFE_BOOT,UserManager.DISALLOW_ADD_USER,UserManager.DISALLOW_CREATE_WINDOWS};
    static SharedPreferences prefs(Context c){return c.getSharedPreferences(PREFS,0);}
    static boolean enabled(Context c){return prefs(c).getBoolean("enabled",false);}
    static DevicePolicyManager dpm(Context c){return (DevicePolicyManager)c.getSystemService(Context.DEVICE_POLICY_SERVICE);}
    static ComponentName admin(Context c){return new ComponentName(c,AdminReceiver.class);}
    static IntentFilter homeFilter(){IntentFilter f=new IntentFilter(Intent.ACTION_MAIN);f.addCategory(Intent.CATEGORY_HOME);f.addCategory(Intent.CATEGORY_DEFAULT);return f;}
    static boolean locked(Context c){return ((ActivityManager)c.getSystemService(Context.ACTIVITY_SERVICE)).getLockTaskModeState()==ActivityManager.LOCK_TASK_MODE_LOCKED;}
    static void open(Context c){c.startActivity(new Intent(c,KioskActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_CLEAR_TOP));}
    static void requireSave(boolean ok){if(!ok)throw new IllegalStateException("تعذر حفظ إعدادات شاشة إنجاز");}

    interface RestrictionClearHook { void beforeClear(String restriction); }
    static RestrictionClearHook clearHookForTest;
    static boolean inMaintenance(Context c) {
        SharedPreferences p=prefs(c);
        return p.getLong("recovery_revision",0)>0 && p.getLong("recovery_revision",0)>=p.getLong("accepted_revision",0);
    }
    static String deviceName(Context c) { String name=prefs(c).getString("device_name","").trim(); return name.isEmpty()?"جهاز الشركة":name; }
    static void cacheDeviceName(Context c,String name) {
        requireSave(prefs(c).edit().putString("device_name",name==null?"":name.trim()).commit());
    }
    static String errorText(Exception ex) { String m=ex.getMessage(); return m==null||m.trim().isEmpty()?"تعذر تطبيق إعدادات شاشة الشركة ("+ex.getClass().getSimpleName()+")":m; }
    static void recordError(Context c,Exception ex) { requireSave(prefs(c).edit().putString("last_error",errorText(ex)).commit()); }
    // Only server-verified documents enter this path. Keep requested state separate from local maintenance.
    static synchronized void apply(Context c,KioskPolicy policy) throws Exception {
        SharedPreferences p=prefs(c);
        if(policy.revision<p.getLong("accepted_revision",0))throw new IllegalArgumentException("Stale kiosk policy");
        boolean keepMaintenance=inMaintenance(c)&&policy.revision<=p.getLong("recovery_revision",0);
        requireSave(p.edit().putLong("accepted_revision",policy.revision).putBoolean("requested_enabled",policy.enabled)
                .putStringSet("apps",new HashSet<>(policy.apps)).putString("exit_salt",policy.salt).putString("exit_hash",policy.hash).commit());
        if(!policy.enabled) {
            requireSave(p.edit().putLong("recovery_revision",0).commit());
            try { disable(c); requireSave(p.edit().putLong("configured_revision",policy.revision).putString("last_error","").commit()); }
            catch(RuntimeException ex) { recordError(c,ex); throw ex; }
            return;
        }
        if(keepMaintenance)return; // same revision refreshes legacy credentials without leaving maintenance
        requireSave(p.edit().putLong("recovery_revision",0).commit());
        try { prepare(c,policy); } catch(Exception ex) { recordError(c,ex); throw ex; }
    }
    static synchronized void resumeMaintenance(Context c,String uid) throws Exception {
        if(uid==null||!SyncEngine.isDeviceApproved(c,uid))throw new IllegalStateException("الجهاز غير معتمد لهذه الهوية");
        SharedPreferences p=prefs(c);
        if(!inMaintenance(c)) { if(enabled(c))return; throw new IllegalStateException("الجهاز ليس في وضع الصيانة"); }
        if(!p.contains("requested_enabled"))throw new IllegalStateException("يلزم إجراء مزامنة واحدة للتحقق من سياسة النسخة السابقة");
        if(!p.getBoolean("requested_enabled",false))throw new IllegalStateException("شاشة الشركة معطلة من الإدارة");
        Map<String,Object> data=new HashMap<>();data.put("schema_version",1L);data.put("revision",p.getLong("accepted_revision",0));
        data.put("enabled",true);data.put("allowed_apps",new ArrayList<>(p.getStringSet("apps",Collections.emptySet())));
        data.put("exit_salt",p.getString("exit_salt",""));data.put("exit_hash",p.getString("exit_hash",""));
        KioskPolicy policy=KioskPolicy.parse(data,p.getLong("accepted_revision",0));
        long recovery=p.getLong("recovery_revision",0);
        requireSave(p.edit().putLong("resume_recovery_revision",recovery).putLong("recovery_revision",0).commit());
        try { prepare(c,policy); }
        catch(Exception ex) {
            requireSave(p.edit().putLong("recovery_revision",recovery).putBoolean("enabled",false).remove("resume_recovery_revision").commit());
            recordError(c,ex);throw ex;
        }
    }
    static synchronized void confirmLocked(Context c) {
        SharedPreferences p=prefs(c);DevicePolicyManager d=dpm(c);ComponentName a=admin(c);
        if(!p.getBoolean("requested_enabled",false)||p.getLong("prepared_revision",0)!=p.getLong("accepted_revision",0)
                ||!enabled(c)||inMaintenance(c)||!locked(c)||!d.isDeviceOwnerApp(c.getPackageName()))throw new IllegalStateException("لم يتم تأكيد قفل شاشة الشركة");
        for(String r:RESTRICTIONS)if(!d.getUserRestrictions(a).getBoolean(r))throw new IllegalStateException("قيد غير مطبق: "+r);
        requireSave(p.edit().putLong("configured_revision",p.getLong("accepted_revision",0)).remove("resume_recovery_revision").putString("last_error","").commit());
    }
    static synchronized void lockFailed(Context c,Exception ex) {
        SharedPreferences p=prefs(c);long recovery=p.getLong("resume_recovery_revision",0);
        if(recovery>0)requireSave(p.edit().putLong("recovery_revision",recovery).putBoolean("enabled",false).remove("resume_recovery_revision").commit());
        recordError(c,ex);
    }
    static synchronized void prepare(Context c,KioskPolicy policy) throws Exception {
        SharedPreferences p=prefs(c);DevicePolicyManager d=dpm(c);ComponentName a=admin(c);
        if(!d.isDeviceOwnerApp(c.getPackageName()))throw new IllegalStateException("Device Owner required");

        if(policy.enabled && Build.VERSION.SDK_INT<30)throw new IllegalStateException("شاشة الشركة التجريبية تتطلب Android 11 أو أحدث");
        // Validate every launch target before changing OS configuration. Blacklist takes precedence.
        if(policy.enabled){
            for(String pkg:policy.apps){
                if(pkg.equals(c.getPackageName()) || pkg.equals("com.android.settings") || pkg.equals("com.android.vending")
                        || c.getPackageManager().getLaunchIntentForPackage(pkg)==null || d.isApplicationHidden(a,pkg))
                    throw new IllegalArgumentException("تطبيق غير متاح أو غير مناسب لشاشة الشركة: "+pkg);
            }
        }

        Set<String> list=new TreeSet<>(policy.apps);list.add(c.getPackageName());
        // Migrate legacy kiosk restrictions and apply required restrictions via unified RestrictionManager
        RestrictionManager.migrateLegacyKioskRestrictions(c);
        boolean blockInstalls = AppInstallPolicy.getLocal(c).blockAppInstalls;
        boolean blockTether = d.getUserRestrictions(a).getBoolean(UserManager.DISALLOW_CONFIG_TETHERING);
        boolean blockLoc = LocationPolicy.getLocal(c).enabled;
        Set<String> required = RestrictionManager.computeRequiredRestrictions(c, true, blockInstalls, blockTether, blockLoc);
        RestrictionManager.reconcile(c, required);

        Set<String> owned = new HashSet<>(RestrictionManager.getOwnedRestrictions(c));
        requireSave(p.edit().putStringSet("owned_restrictions", owned).putBoolean("managed", true).commit());

        // Make local password recovery reachable before any OS restriction can fail.
        if (c.getPackageManager().getComponentEnabledSetting(new ComponentName(c,KioskActivity.class)) != PackageManager.COMPONENT_ENABLED_STATE_ENABLED)
            c.getPackageManager().setComponentEnabledSetting(new ComponentName(c,KioskActivity.class),PackageManager.COMPONENT_ENABLED_STATE_ENABLED,PackageManager.DONT_KILL_APP);
        requireSave(p.edit().putStringSet("apps",new HashSet<>(policy.apps)).putBoolean("enabled",true).commit());
        d.setLockTaskPackages(a,list.toArray(new String[0]));
        if(Build.VERSION.SDK_INT>=30)d.setLockTaskFeatures(a,DevicePolicyManager.LOCK_TASK_FEATURE_HOME
                |DevicePolicyManager.LOCK_TASK_FEATURE_SYSTEM_INFO|DevicePolicyManager.LOCK_TASK_FEATURE_KEYGUARD
                |DevicePolicyManager.LOCK_TASK_FEATURE_GLOBAL_ACTIONS|DevicePolicyManager.LOCK_TASK_FEATURE_BLOCK_ACTIVITY_START_IN_TASK);
        d.addPersistentPreferredActivity(a,homeFilter(),new ComponentName(c,KioskActivity.class));
        if (!new HashSet<>(Arrays.asList(d.getLockTaskPackages(a))).equals(list)) throw new IllegalStateException("تعذر تأكيد التطبيقات المسموحة");
        for(String r:RESTRICTIONS) if(!d.getUserRestrictions(a).getBoolean(r)) throw new IllegalStateException("تعذر تأكيد قيد شاشة الشركة: "+r);
        requireSave(p.edit().putLong("prepared_revision",policy.revision).commit());
        if(locked(c))confirmLocked(c); // otherwise KioskActivity confirms the actual lock after startLockTask
        // Avoid stealing focus from allowed work apps during every background sync.
        if(!locked(c))open(c);
        c.sendBroadcast(new Intent("com.company.mdmagent.KIOSK_UPDATED").setPackage(c.getPackageName()));
    }
    static void disable(Context c){
        SharedPreferences p=prefs(c);DevicePolicyManager d=dpm(c);ComponentName a=admin(c);
        if(!d.isDeviceOwnerApp(c.getPackageName()))throw new IllegalStateException("Device Owner required");
        if(!p.getBoolean("managed",false)&&p.getStringSet("owned_restrictions",Collections.emptySet()).isEmpty())return;
        List<String> errors=new ArrayList<>();
        try { d.setLockTaskPackages(a,new String[0]); } catch(RuntimeException ex) { errors.add(errorText(ex)); }
        try { d.clearPackagePersistentPreferredActivities(a,c.getPackageName()); } catch(RuntimeException ex) { errors.add(errorText(ex)); }

        // Reconcile via unified RestrictionManager with kiosk disabled; preserves independent install & tethering
        try {
            RestrictionManager.migrateLegacyKioskRestrictions(c);
            boolean blockInstalls = AppInstallPolicy.getLocal(c).blockAppInstalls;
            boolean blockTether = d.getUserRestrictions(a).getBoolean(UserManager.DISALLOW_CONFIG_TETHERING);
            boolean blockLoc = LocationPolicy.getLocal(c).enabled;
            Set<String> required = RestrictionManager.computeRequiredRestrictions(c, false, blockInstalls, blockTether, blockLoc);
            RestrictionManager.reconcile(c, required);
        } catch (Exception ex) {
            errors.add("restrictionReconcile: " + errorText(ex));
        }

        Set<String> remaining = new HashSet<>(RestrictionManager.getOwnedRestrictions(c));
        requireSave(p.edit().putStringSet("owned_restrictions",remaining).commit());
        if(!errors.isEmpty())throw new IllegalStateException(String.join("; ",errors));
        c.getPackageManager().setComponentEnabledSetting(new ComponentName(c,KioskActivity.class),PackageManager.COMPONENT_ENABLED_STATE_DISABLED,PackageManager.DONT_KILL_APP);
        requireSave(p.edit().putBoolean("enabled",false).putBoolean("managed",false).commit());
        c.sendBroadcast(new Intent("com.company.mdmagent.KIOSK_UPDATED").setPackage(c.getPackageName()));
    }
    static synchronized boolean recover(Context c,char[] password)throws Exception{
        SharedPreferences p=prefs(c);long now=System.currentTimeMillis();
        if(now<p.getLong("retry_after",0))return false;
        byte[] salt=hex(p.getString("exit_salt",""));
        PBEKeySpec spec=new PBEKeySpec(password,salt,120000,256);byte[] actual;
        try{actual=SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();}
        finally{spec.clearPassword();Arrays.fill(password,'\0');}
        boolean valid=MessageDigest.isEqual(actual,hex(p.getString("exit_hash","")));
        if(!valid){int count=p.getInt("failures",0)+1;requireSave(p.edit().putInt("failures",count).putLong("retry_after",now+(count>=5?300000:2000)).commit());return false;}
        // A running legacy kiosk is evidence of an enabled accepted policy; legacy maintenance needs server verification.
        if(!p.contains("requested_enabled")&&enabled(c))requireSave(p.edit().putBoolean("requested_enabled",true).commit());
        disable(c);
        requireSave(p.edit().putLong("recovery_revision",p.getLong("accepted_revision",0)).putInt("failures",0).putLong("retry_after",0).putString("last_error","").commit());
        SyncEngine.requestSync(c,"kiosk_admin_recovery");return true;
    }
    static byte[] hex(String s){byte[] out=new byte[s.length()/2];for(int i=0;i<out.length;i++)out[i]=(byte)Integer.parseInt(s.substring(i*2,i*2+2),16);return out;}
    static String synchronize(Context c,FirebaseFirestore db,String uid){
        String error="";SharedPreferences p=prefs(c);
        try {
            DocumentSnapshot meta=Tasks.await(db.collection("deviceMetadata").document(uid).get(Source.SERVER),10,TimeUnit.SECONDS);
            cacheDeviceName(c,meta.exists()?meta.getString("device_name"):null);
        }catch(Exception ex){android.util.Log.w(SyncEngine.TAG,"device_name_refresh_failed",ex);}
        try{
            DocumentSnapshot snap=Tasks.await(db.collection("kioskPolicies").document(uid).get(Source.SERVER),20,TimeUnit.SECONDS);
            if(snap.exists())apply(c,KioskPolicy.parse(snap.getData(),p.getLong("accepted_revision",0)));
            else if(p.getLong("accepted_revision",0)>0)throw new IllegalStateException("سياسة الشاشة مفقودة؛ الإعدادات الحالية محفوظة");
        }catch(Exception ex){error=ex.getClass().getSimpleName()+": "+String.valueOf(ex.getMessage());}
        if(error.isEmpty())error=p.getString("last_error","");
        try{publishStatus(c,db,uid,error);}catch(Exception ex){android.util.Log.w(SyncEngine.TAG,"kiosk_status_upload_failed",ex);}
        return error;
    }
    static void queueStatus(Context c) {
        Context app=c.getApplicationContext();
        AgentApp.SYNC.execute(()->{
            try { String uid=SyncEngine.getCurrentAuthenticatedUid();
                if(uid!=null&&SyncEngine.isDeviceApproved(app,uid))publishStatus(app,FirebaseFirestore.getInstance(),uid,prefs(app).getString("last_error",""));
            }catch(Exception ex){android.util.Log.w(SyncEngine.TAG,"kiosk_status_pending",ex);}
        });
    }
    static void publishStatus(Context c,FirebaseFirestore db,String uid,String error)throws Exception{
        SharedPreferences p=prefs(c);DevicePolicyManager d=dpm(c);ComponentName a=admin(c);
        boolean active=locked(c);
        boolean restricted=d.isDeviceOwnerApp(c.getPackageName())&&d.getUserRestrictions(a).getBoolean(UserManager.DISALLOW_INSTALL_APPS);
        Map<String,Object> s=new HashMap<>();s.put("configured_revision",p.getLong("configured_revision",0));
        s.put("active",active);s.put("install_blocked",restricted);s.put("maintenance",inMaintenance(c));
        s.put("error",error.substring(0,Math.min(1000,error.length())));s.put("reported_at",FieldValue.serverTimestamp());
        Tasks.await(db.collection("kioskStatus").document(uid).set(s),20,TimeUnit.SECONDS);
    }
}

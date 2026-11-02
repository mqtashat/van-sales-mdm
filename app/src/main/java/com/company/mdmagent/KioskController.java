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
    static final String PREFS="injaz-kiosk";
    static final String[] RESTRICTIONS={UserManager.DISALLOW_INSTALL_APPS,UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES,
            UserManager.DISALLOW_SAFE_BOOT,UserManager.DISALLOW_ADD_USER,UserManager.DISALLOW_CREATE_WINDOWS};
    static SharedPreferences prefs(Context c){return c.getSharedPreferences(PREFS,0);}
    static boolean enabled(Context c){return prefs(c).getBoolean("enabled",false);}
    static DevicePolicyManager dpm(Context c){return (DevicePolicyManager)c.getSystemService(Context.DEVICE_POLICY_SERVICE);}
    static ComponentName admin(Context c){return new ComponentName(c,AdminReceiver.class);}
    static IntentFilter homeFilter(){IntentFilter f=new IntentFilter(Intent.ACTION_MAIN);f.addCategory(Intent.CATEGORY_HOME);f.addCategory(Intent.CATEGORY_DEFAULT);return f;}
    static boolean locked(Context c){return ((ActivityManager)c.getSystemService(Context.ACTIVITY_SERVICE)).getLockTaskModeState()==ActivityManager.LOCK_TASK_MODE_LOCKED;}
    static void open(Context c){c.startActivity(new Intent(c,KioskActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_CLEAR_TOP));}
    static void requireSave(boolean ok){if(!ok)throw new IllegalStateException("تعذر حفظ إعدادات شاشة إنجاز");}

    static synchronized void apply(Context c,KioskPolicy policy) throws Exception {
        SharedPreferences p=prefs(c);DevicePolicyManager d=dpm(c);ComponentName a=admin(c);
        if(!d.isDeviceOwnerApp(c.getPackageName()))throw new IllegalStateException("Device Owner required");
        if(!KioskPolicy.shouldApply(policy.revision,p.getLong("recovery_revision",0))) return;
        if(policy.enabled && Build.VERSION.SDK_INT<30)throw new IllegalStateException("شاشة الشركة التجريبية تتطلب Android 11 أو أحدث");
        // Validate every launch target before changing OS configuration. Blacklist takes precedence.
        if(policy.enabled){
            for(String pkg:policy.apps){
                if(pkg.equals(c.getPackageName()) || pkg.equals("com.android.settings") || pkg.equals("com.android.vending")
                        || c.getPackageManager().getLaunchIntentForPackage(pkg)==null || d.isApplicationHidden(a,pkg))
                    throw new IllegalArgumentException("تطبيق غير متاح أو غير مناسب لشاشة الشركة: "+pkg);
            }
        }
        requireSave(p.edit().putLong("accepted_revision",policy.revision).putString("exit_salt",policy.salt)
                .putString("exit_hash",policy.hash).commit());
        if(!policy.enabled){disable(c);requireSave(p.edit().putLong("configured_revision",policy.revision).commit());return;}
        Set<String> list=new TreeSet<>(policy.apps);list.add(c.getPackageName());
        // Journal which restrictions belong to this feature; never clear unrelated existing restrictions.
        if(!p.getBoolean("managed",false)){
            Set<String> owned=new HashSet<>();for(String r:RESTRICTIONS)if(!d.getUserRestrictions(a).getBoolean(r))owned.add(r);
            requireSave(p.edit().putStringSet("owned_restrictions",owned).putBoolean("managed",true).commit());
        }
        requireSave(p.edit().putStringSet("apps",new HashSet<>(policy.apps)).putBoolean("enabled",true).commit());
        d.setLockTaskPackages(a,list.toArray(new String[0]));
        if(Build.VERSION.SDK_INT>=30)d.setLockTaskFeatures(a,DevicePolicyManager.LOCK_TASK_FEATURE_HOME
                |DevicePolicyManager.LOCK_TASK_FEATURE_SYSTEM_INFO|DevicePolicyManager.LOCK_TASK_FEATURE_KEYGUARD
                |DevicePolicyManager.LOCK_TASK_FEATURE_GLOBAL_ACTIONS|DevicePolicyManager.LOCK_TASK_FEATURE_BLOCK_ACTIVITY_START_IN_TASK);
        for(String r:RESTRICTIONS)d.addUserRestriction(a,r);
        if (c.getPackageManager().getComponentEnabledSetting(new ComponentName(c,KioskActivity.class)) != PackageManager.COMPONENT_ENABLED_STATE_ENABLED)
            c.getPackageManager().setComponentEnabledSetting(new ComponentName(c,KioskActivity.class),PackageManager.COMPONENT_ENABLED_STATE_ENABLED,PackageManager.DONT_KILL_APP);
        d.addPersistentPreferredActivity(a,homeFilter(),new ComponentName(c,KioskActivity.class));
        if (!new HashSet<>(Arrays.asList(d.getLockTaskPackages(a))).equals(list)) throw new IllegalStateException("تعذر تأكيد التطبيقات المسموحة");
        for(String r:RESTRICTIONS) if(!d.getUserRestrictions(a).getBoolean(r)) throw new IllegalStateException("تعذر تأكيد قيد شاشة الشركة: "+r);
        requireSave(p.edit().putLong("configured_revision",policy.revision).commit());
        // Avoid stealing focus from allowed work apps during every background sync.
        if(!locked(c))open(c);
        c.sendBroadcast(new Intent("com.company.mdmagent.KIOSK_UPDATED").setPackage(c.getPackageName()));
    }
    static void disable(Context c){
        SharedPreferences p=prefs(c);DevicePolicyManager d=dpm(c);ComponentName a=admin(c);
        if(!p.getBoolean("managed",false))return;
        d.setLockTaskPackages(a,new String[0]); // Removing all packages exits locked tasks on supported Android versions.
        d.clearPackagePersistentPreferredActivities(a,c.getPackageName());
        c.getPackageManager().setComponentEnabledSetting(new ComponentName(c,KioskActivity.class),PackageManager.COMPONENT_ENABLED_STATE_DISABLED,PackageManager.DONT_KILL_APP);
        for(String r:p.getStringSet("owned_restrictions",Collections.emptySet()))d.clearUserRestriction(a,r);
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
        requireSave(p.edit().putLong("recovery_revision",p.getLong("accepted_revision",0)).putInt("failures",0).putLong("retry_after",0).commit());
        disable(c);SyncEngine.requestSync(c,"kiosk_admin_recovery");return true;
    }
    static byte[] hex(String s){byte[] out=new byte[s.length()/2];for(int i=0;i<out.length;i++)out[i]=(byte)Integer.parseInt(s.substring(i*2,i*2+2),16);return out;}
    static String synchronize(Context c,FirebaseFirestore db,String uid){
        String error="";SharedPreferences p=prefs(c);
        try{
            DocumentSnapshot snap=Tasks.await(db.collection("kioskPolicies").document(uid).get(Source.SERVER),20,TimeUnit.SECONDS);
            if(snap.exists())apply(c,KioskPolicy.parse(snap.getData(),p.getLong("accepted_revision",0)));
            else if(p.getLong("accepted_revision",0)>0)throw new IllegalStateException("سياسة الشاشة مفقودة؛ الإعدادات الحالية محفوظة");
        }catch(Exception ex){error=ex.getClass().getSimpleName()+": "+String.valueOf(ex.getMessage());}
        try{publishStatus(c,db,uid,error);}catch(Exception ex){android.util.Log.w(SyncEngine.TAG,"kiosk_status_upload_failed",ex);}
        return error;
    }
    static void publishStatus(Context c,FirebaseFirestore db,String uid,String error)throws Exception{
        SharedPreferences p=prefs(c);DevicePolicyManager d=dpm(c);ComponentName a=admin(c);
        boolean active=enabled(c)&&locked(c);
        boolean restricted=d.isDeviceOwnerApp(c.getPackageName())&&d.getUserRestrictions(a).getBoolean(UserManager.DISALLOW_INSTALL_APPS);
        Map<String,Object> s=new HashMap<>();s.put("configured_revision",p.getLong("configured_revision",0));
        s.put("active",active);s.put("install_blocked",restricted);s.put("maintenance",p.getLong("recovery_revision",0)>=p.getLong("accepted_revision",0)&&p.getLong("recovery_revision",0)>0);
        s.put("error",error.substring(0,Math.min(1000,error.length())));s.put("reported_at",FieldValue.serverTimestamp());
        Tasks.await(db.collection("kioskStatus").document(uid).set(s),20,TimeUnit.SECONDS);
    }
}

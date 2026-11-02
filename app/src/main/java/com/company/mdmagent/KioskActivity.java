package com.company.mdmagent;

import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.*;
import android.view.*;
import android.widget.*;
import java.util.*;

/** Company home screen. Only explicit server-approved package launch intents are offered. */
public class KioskActivity extends Activity {
    private final BroadcastReceiver changed=new BroadcastReceiver(){public void onReceive(Context c,Intent i){render();}};
    private boolean registered;
    @Override public void onCreate(Bundle state){
        super.onCreate(state);
        if(Build.VERSION.SDK_INT>=33)registerReceiver(changed,new IntentFilter("com.company.mdmagent.KIOSK_UPDATED"),Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(changed,new IntentFilter("com.company.mdmagent.KIOSK_UPDATED"));
        registered=true;
    }
    @Override protected void onResume(){super.onResume();render();}
    private void render(){
        if(!KioskController.enabled(this)){finish();return;}
        if(!KioskController.dpm(this).isLockTaskPermitted(getPackageName())){showError("تعذر تفعيل قفل الشاشة؛ تواصل مع الإدارة");return;}
        try {if(!KioskController.locked(this))startLockTask();}
        catch(RuntimeException ex){showError("تعذر بدء قفل شاشة الشركة: "+ex.getMessage());return;}
        ScrollView scroll=new ScrollView(this);scroll.setBackgroundColor(Color.rgb(10,24,44));
        LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setPadding(24,48,24,24);root.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);scroll.addView(root);
        TextView brand=new TextView(this);brand.setText("إنجاز");brand.setTextSize(38);brand.setTextColor(Color.WHITE);brand.setTypeface(null,Typeface.BOLD);root.addView(brand);
        TextView hint=new TextView(this);hint.setText("جهاز الشركة • تطبيقات العمل");hint.setTextColor(Color.rgb(150,190,210));hint.setTextSize(17);hint.setPadding(0,12,0,32);root.addView(hint);
        Set<String> apps=KioskController.prefs(this).getStringSet("apps",Collections.emptySet());
        GridLayout grid=new GridLayout(this);grid.setColumnCount(2);root.addView(grid);
        for(String pkg:new TreeSet<>(apps)){
            Button tile=new Button(this);String label=pkg;
            try {label=getPackageManager().getApplicationLabel(getPackageManager().getApplicationInfo(pkg,0)).toString();
                android.graphics.drawable.Drawable icon=getPackageManager().getApplicationIcon(pkg);icon.setBounds(0,0,72,72);tile.setCompoundDrawables(null,icon,null,null);tile.setCompoundDrawablePadding(16);
            }catch(Exception ignored){ /* Retain package label so a missing app remains explainable. */ }
            tile.setText(label);tile.setTextSize(18);tile.setAllCaps(false);tile.setPadding(12,20,12,20);
            GridLayout.LayoutParams lp=new GridLayout.LayoutParams();lp.width=0;lp.height=180;lp.columnSpec=GridLayout.spec(GridLayout.UNDEFINED,1f);lp.setMargins(6,6,6,6);tile.setLayoutParams(lp);
            tile.setOnClickListener(v->{
                if(!KioskController.prefs(this).getStringSet("apps",Collections.emptySet()).contains(pkg))return;
                Intent launch=getPackageManager().getLaunchIntentForPackage(pkg);
                if(launch==null){Toast.makeText(this,"التطبيق غير متاح؛ راجع الإدارة",Toast.LENGTH_LONG).show();return;}
                if (Build.VERSION.SDK_INT < 30) return;
                try{ActivityOptions opts=ActivityOptions.makeBasic();opts.setLockTaskEnabled(true);startActivity(launch,opts.toBundle());}
                catch(RuntimeException ex){Toast.makeText(this,"تعذر فتح التطبيق: "+ex.getMessage(),Toast.LENGTH_LONG).show();}
            });grid.addView(tile);
        }
        Button sync=new Button(this);sync.setText("تحديث تطبيقات العمل");sync.setOnClickListener(v->{SyncEngine.requestSync(this,"kiosk_refresh");Toast.makeText(this,"جارٍ التحقق من الإدارة",Toast.LENGTH_SHORT).show();});root.addView(sync);
        Button admin=new Button(this);admin.setText("دخول المدير للصيانة");admin.setOnClickListener(v->maintenance());root.addView(admin);
        TextView notice=new TextView(this);notice.setText("تثبيت التطبيقات متاح للإدارة فقط\nتظل إعدادات العمل محفوظة عند انقطاع الإنترنت");notice.setTextColor(Color.LTGRAY);notice.setPadding(0,24,0,8);root.addView(notice);
        setContentView(scroll);
        AgentApp.SYNC.execute(()->{try{String uid=SyncEngine.getCurrentAuthenticatedUid();if(uid!=null&&SyncEngine.isDeviceApproved(this,uid))KioskController.publishStatus(this,com.google.firebase.firestore.FirebaseFirestore.getInstance(),uid,"");}catch(Exception ex){android.util.Log.w(SyncEngine.TAG,"kiosk_ui_status_failed",ex);}});
    }
    private void showError(String message){LinearLayout root=new LinearLayout(this);root.setOrientation(1);TextView t=new TextView(this);t.setText(message);root.addView(t);Button b=new Button(this);b.setText("صيانة المدير");b.setOnClickListener(v->maintenance());root.addView(b);setContentView(root);}
    private void maintenance(){
        EditText password=new EditText(this);password.setInputType(android.text.InputType.TYPE_CLASS_TEXT|android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD);
        password.setHint("كلمة مرور صيانة هذا الجهاز");
        AlertDialog dialog=new AlertDialog.Builder(this).setTitle("خروج المدير من شاشة الشركة").setMessage("يستمر منع مشاركة الإنترنت والحظر الحالي. إعادة تفعيل الشاشة تكون من اللوحة.").setView(password).setNegativeButton("إلغاء",null).setPositiveButton("دخول",null).create();
        dialog.setOnShowListener(x->dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v->{
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false);char[] secret=password.getText().toString().toCharArray();password.setText("");
            AgentApp.SYNC.execute(()->{try{boolean ok=KioskController.recover(getApplicationContext(),secret);runOnUiThread(()->{if(ok){dialog.dismiss();startActivity(new Intent(this,MainActivity.class));finish();}else{dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(true);password.setError("كلمة مرور غير صحيحة أو محاولات كثيرة؛ انتظر ثم أعد المحاولة");}});}catch(Exception ex){runOnUiThread(()->{dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(true);password.setError("تعذر إكمال الصيانة");});}});
        }));dialog.show();
    }
    @Override public void onBackPressed(){ /* Company home stays foreground. */ }
    @Override protected void onDestroy(){if(registered)unregisterReceiver(changed);super.onDestroy();}
}

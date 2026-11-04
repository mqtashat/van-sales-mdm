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
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    @Override public void onCreate(Bundle state){
        super.onCreate(state);
        androidx.core.content.ContextCompat.registerReceiver(this, changed,
                new IntentFilter("com.company.mdmagent.KIOSK_UPDATED"), androidx.core.content.ContextCompat.RECEIVER_NOT_EXPORTED);
        registered=true;
    }
    @Override protected void onResume(){super.onResume();render();}
    private void render(){
        if(!KioskController.enabled(this)){
            if(KioskController.prefs(this).getBoolean("managed",false))showError("لم تكتمل إعادة التفعيل؛ يمكنك إعادة المحاولة أو دخول الصيانة");
            else finish();
            return;
        }
        if(KioskController.prefs(this).contains("requested_enabled")&&!KioskController.prefs(this).getBoolean("requested_enabled",false)){
            showError("لم يكتمل تعطيل شاشة الشركة؛ أعد المزامنة أو ادخل صيانة المدير");return;
        }
        if(!KioskController.dpm(this).isLockTaskPermitted(getPackageName())){showError("تعذر تفعيل قفل الشاشة؛ تواصل مع الإدارة");return;}
        try {if(!KioskController.locked(this))startLockTask();}
        catch(RuntimeException ex){KioskController.lockFailed(this,ex);KioskController.queueStatus(this);showError("تعذر بدء قفل شاشة الشركة: "+ex.getMessage());return;}
        try { KioskController.confirmLocked(this); }
        catch(RuntimeException ex){KioskController.lockFailed(this,ex);KioskController.queueStatus(this);showError(KioskController.errorText(ex));return;}
        ScrollView scroll=new ScrollView(this);scroll.setBackgroundColor(Color.rgb(10,24,44));
        LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setPadding(dp(20),dp(32),dp(20),dp(20));root.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);scroll.addView(root);
        TextView brand=new TextView(this);brand.setText("إنجاز");brand.setTextSize(38);brand.setTextColor(Color.WHITE);brand.setTypeface(null,Typeface.BOLD);root.addView(brand);
        TextView hint=new TextView(this);hint.setText(KioskController.deviceName(this));hint.setTextColor(Color.rgb(150,190,210));hint.setTextSize(17);hint.setPadding(0,12,0,32);root.addView(hint);
        Set<String> apps=KioskController.prefs(this).getStringSet("apps",Collections.emptySet());
        GridLayout grid=new GridLayout(this);grid.setColumnCount(4);root.addView(grid);
        for(String pkg:new TreeSet<>(apps)){
            Button tile=new Button(this);String label=pkg;
            try {label=getPackageManager().getApplicationLabel(getPackageManager().getApplicationInfo(pkg,0)).toString();
                android.graphics.drawable.Drawable icon=getPackageManager().getApplicationIcon(pkg);icon.setBounds(0,0,dp(48),dp(48));tile.setCompoundDrawables(null,icon,null,null);tile.setCompoundDrawablePadding(dp(12));
            }catch(Exception ignored){ /* Retain package label so a missing app remains explainable. */ }
            tile.setMinWidth(0);tile.setMinimumWidth(0);tile.setMaxLines(2);tile.setEllipsize(android.text.TextUtils.TruncateAt.END);
            tile.setText(label);tile.setTextSize(13);tile.setAllCaps(false);tile.setTextColor(Color.WHITE);
            tile.setBackgroundColor(Color.TRANSPARENT);tile.setElevation(0);tile.setPadding(dp(4),dp(12),dp(4),dp(12));
            GridLayout.LayoutParams lp=new GridLayout.LayoutParams();lp.width=0;lp.height=dp(124);lp.columnSpec=GridLayout.spec(GridLayout.UNDEFINED,1f);lp.setMargins(dp(5),dp(5),dp(5),dp(5));tile.setLayoutParams(lp);
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
        scroll.setOnApplyWindowInsetsListener((view,insets)->{
            if(Build.VERSION.SDK_INT>=30){android.graphics.Insets bars=insets.getInsets(WindowInsets.Type.systemBars());view.setPadding(bars.left,bars.top,bars.right,bars.bottom);}
            return insets;
        });
        scroll.requestApplyInsets();
        AgentApp.SYNC.execute(()->{try{String uid=SyncEngine.getCurrentAuthenticatedUid();if(uid!=null&&SyncEngine.isDeviceApproved(this,uid))KioskController.publishStatus(this,com.google.firebase.firestore.FirebaseFirestore.getInstance(),uid,KioskController.prefs(this).getString("last_error",""));}catch(Exception ex){android.util.Log.w(SyncEngine.TAG,"kiosk_ui_status_failed",ex);}});
    }
    private void showError(String message){LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);TextView t=new TextView(this);t.setText(message);root.addView(t);Button b=new Button(this);b.setText("صيانة المدير");b.setOnClickListener(v->maintenance());root.addView(b);
        Button refresh=new Button(this);refresh.setText("مزامنة والتحقق الآن");refresh.setOnClickListener(v->SyncEngine.requestSync(this,"kiosk_retry"));root.addView(refresh);
        if(KioskController.inMaintenance(this)){
            Button resume=new Button(this);resume.setText("إنهاء الصيانة والعودة لشاشة الشركة");root.addView(resume);
            resume.setOnClickListener(v->{resume.setEnabled(false);KioskController.LOCAL.execute(()->{
                try{KioskController.resumeMaintenance(getApplicationContext(),SyncEngine.getCurrentAuthenticatedUid());runOnUiThread(this::render);}
                catch(Exception ex){runOnUiThread(()->{resume.setEnabled(true);t.setText(KioskController.errorText(ex));});}
                KioskController.queueStatus(getApplicationContext());
            });});
        }
        setContentView(root);}
    private void maintenance(){
        EditText password=new EditText(this);MaintenanceInput.configure(password, false);
        password.setHint("رمز الصيانة: 4–6 خانات (0–9، *، #)");
        android.widget.LinearLayout fields=new android.widget.LinearLayout(this);
        fields.setOrientation(android.widget.LinearLayout.VERTICAL);fields.addView(password);
        android.widget.CheckBox legacy=new android.widget.CheckBox(this);
        legacy.setText("استخدام كلمة المرور القديمة");fields.addView(legacy);
        legacy.setOnCheckedChangeListener((button,checked)->{MaintenanceInput.configure(password,checked);password.requestFocus();});
        AlertDialog dialog=new AlertDialog.Builder(this).setTitle("خروج المدير من شاشة الشركة").setMessage("يستمر منع مشاركة الإنترنت والحظر الحالي. للعودة استخدم زر إنهاء الصيانة داخل تطبيق إنجاز، أو أعد التفعيل من اللوحة.").setView(fields).setNegativeButton("إلغاء",null).setPositiveButton("دخول",null).create();
        dialog.setOnShowListener(x->dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v->{
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false);char[] secret=password.getText().toString().toCharArray();password.setText("");
            KioskController.LOCAL.execute(()->{try{boolean ok=KioskController.recover(getApplicationContext(),secret);runOnUiThread(()->{if(ok){dialog.dismiss();startActivity(new Intent(this,MainActivity.class));finish();}else{dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(true);password.setError("كلمة مرور غير صحيحة أو محاولات كثيرة؛ انتظر ثم أعد المحاولة");}});}catch(Exception ex){runOnUiThread(()->{dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(true);password.setError("تعذر إكمال الصيانة");});}});
        }));dialog.show();
        password.requestFocus();
        dialog.getWindow().setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE);
    }
    @Override public void onBackPressed(){ /* Company home stays foreground. */ }
    @Override protected void onDestroy(){if(registered)unregisterReceiver(changed);super.onDestroy();}
}

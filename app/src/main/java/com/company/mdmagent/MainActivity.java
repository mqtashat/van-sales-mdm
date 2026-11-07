package com.company.mdmagent;

import android.Manifest;
import android.app.Activity;
import android.app.admin.DevicePolicyManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.app.AlertDialog;
import android.widget.EditText;
import android.text.InputType;
import android.util.Log;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseUser;

public class MainActivity extends Activity {
    private static final String TAG = "InjazMdmAgent";
    private static final int REQ_POST_NOTIFICATIONS = 2001;

    private TextView identity;
    private TextView deviceHeading, deviceUid, diagnostics;
    private Button register, copy;
    private TextView status;
    private String syncDetails = "";
    private Button sync;
    private Button resumeKiosk;
    private boolean resumingKiosk;
    private boolean notificationPermissionRequested = false;
    private final SharedPreferences.OnSharedPreferenceChangeListener pushStatusListener =
            (preferences, key) -> runOnUiThread(this::updateIdentityView);

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (KioskController.enabled(this)) { KioskController.open(this); finish(); return; }
        DeviceScreen screen=new DeviceScreen(this);
        screen.title("INJAZ.MDM",28,android.graphics.Color.WHITE).setTextDirection(View.TEXT_DIRECTION_LTR);
        screen.title("إدارة الجهاز",21,android.graphics.Color.WHITE);
        deviceHeading=screen.title(KioskController.deviceName(this),17,DeviceScreen.BLUE);
        LinearLayout stateCard=screen.card("حالة الجهاز");
        identity=screen.text("",15,android.graphics.Color.WHITE);stateCard.addView(identity);
        Button details=screen.button("تفاصيل حالة الإدارة");stateCard.addView(details);
        details.setOnClickListener(v->{
            DevicePolicyManager dpm=(DevicePolicyManager)getSystemService(DEVICE_POLICY_SERVICE);
            boolean owner=dpm!=null&&dpm.isDeviceOwnerApp(getPackageName());
            new AlertDialog.Builder(this).setTitle("إدارة الجهاز").setMessage(owner
                ? "إدارة جهاز الشركة مفعّلة. يستطيع النظام تطبيق سياسات الشركة على هذا الهاتف. للصيانة المؤقتة استخدم وضع الصيانة، ثم عُد لشاشة الشركة عند الانتهاء. هذا الخيار يعرض الحالة فقط ولا يلغي الإدارة أو يمسح البيانات."
                : "إدارة جهاز الشركة غير مفعّلة. تواصل مع مسؤول النظام لإكمال إعداد الجهاز.").setPositiveButton("حسنًا",null).show();
        });
        LinearLayout infoCard=screen.card("معلومات الجهاز");
        infoCard.addView(screen.text("معرّف الجهاز UID",14,DeviceScreen.BLUE));
        deviceUid=screen.text("",15,android.graphics.Color.WHITE);deviceUid.setTextDirection(View.TEXT_DIRECTION_LTR);deviceUid.setTextIsSelectable(true);infoCard.addView(deviceUid);
        infoCard.addView(screen.text("إصدار التطبيق: "+SyncEngine.AGENT_VERSION,14,android.graphics.Color.LTGRAY));
        register=screen.button("تسجيل الجهاز");infoCard.addView(register);
        register.setOnClickListener(v -> {
            requestNotificationPermissionIfNeeded();
            if (FirebaseAuth.getInstance().getCurrentUser() != null) {
                attachAndSync("register_already_signed_in");
                return;
            }
            register.setEnabled(false);
            FirebaseAuth.getInstance().signInAnonymously().addOnCompleteListener(this, task -> {
                register.setEnabled(true);
                if (task.isSuccessful()) {
                    Log.i(TAG, "ui_anonymous_auth_success");
                    attachAndSync("register_new_anonymous");
                } else {
                    Log.w(TAG, "ui_anonymous_auth_failed: " + String.valueOf(task.getException()));
                    status.setText("تعذر تسجيل الجهاز. تحقق من الإنترنت أو تواصل مع مسؤول النظام.");
                }
            });
        });

        copy = screen.button("نسخ معرّف الجهاز");
        copy.setText("نسخ معرّف الجهاز UID");
        infoCard.addView(copy);
        copy.setOnClickListener(v -> {
            FirebaseUser currentUser = FirebaseAuth.getInstance().getCurrentUser();
            if (currentUser != null) {
                ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                if (cm != null) {
                    cm.setPrimaryClip(ClipData.newPlainText("Device UID", currentUser.getUid()));
                    Toast.makeText(this, "تم النسخ", Toast.LENGTH_SHORT).show();
                }
            }
        });

        LinearLayout actionCard=screen.card("المزامنة والتحقق");
        sync = screen.button("مزامنة والتحقق الآن");
        sync.setText("مزامنة والتحقق الآن");
        actionCard.addView(sync);
        sync.setOnClickListener(v -> {
            Log.i(TAG, "ui_manual_sync_clicked");
            requestNotificationPermissionIfNeeded();
            SyncEngine.requestSync(getApplicationContext(), "ui_manual_button");
        });

        resumeKiosk = screen.button("إنهاء الصيانة والعودة لشاشة الشركة");
        resumeKiosk.setText("إنهاء الصيانة والعودة لشاشة الشركة");
        resumeKiosk.setVisibility(KioskController.inMaintenance(this)?View.VISIBLE:View.GONE);
        screen.footer.addView(resumeKiosk);
        resumeKiosk.setOnClickListener(v -> {
            if(resumingKiosk)return;
            resumingKiosk=true;resumeKiosk.setEnabled(false);
            KioskController.LOCAL.execute(() -> {
                String error="";
                try { KioskController.resumeMaintenance(getApplicationContext(),SyncEngine.getCurrentAuthenticatedUid()); }
                catch(Exception ex){error=KioskController.errorText(ex);}
                final String result=error;
                runOnUiThread(() -> {
                    resumingKiosk=false;resumeKiosk.setEnabled(true);
                    resumeKiosk.setVisibility(KioskController.inMaintenance(this)?View.VISIBLE:View.GONE);
                    if(!result.isEmpty())status.setText(result);
                });
                KioskController.queueStatus(getApplicationContext());
            });
        });

        status=screen.text("",14,android.graphics.Color.WHITE);status.setTextIsSelectable(true);actionCard.addView(status);
        android.widget.Button syncDetailsButton = screen.button("عرض تفاصيل المزامنة");
        actionCard.addView(syncDetailsButton);
        syncDetailsButton.setOnClickListener(v -> new android.app.AlertDialog.Builder(this)
                .setTitle("تفاصيل المزامنة").setMessage(syncDetails.isEmpty() ? "لا توجد تفاصيل بعد" : syncDetails)
                .setPositiveButton("إغلاق", null).show());
        LinearLayout callCard=screen.card("تجربة سجل المكالمات");
        callCard.addView(screen.text("اختبار محلي داخل الصيانة فقط؛ لا يرسل أرقامًا أو مكالمات للوحة. يبدأ بعد التفعيل الصريح ولا يستورد السجل القديم.",14,android.graphics.Color.LTGRAY));
        Button callPilot=screen.button("فتح اختبار المكالمات");callCard.addView(callPilot);
        callPilot.setOnClickListener(v -> {
            if (!CallLogPilotActivity.canAccess(this)) {
                Toast.makeText(this,"يلزم جهاز شركة معتمد والدخول إلى وضع الصيانة برمز المدير.",Toast.LENGTH_LONG).show();
                return;
            }
            startActivity(new android.content.Intent(this,CallLogPilotActivity.class));
        });
        LinearLayout more=screen.card("معلومات إضافية");
        Button expand=screen.button("عرض الخصوصية والتشخيص");more.addView(expand);
        LinearLayout extra=screen.column();extra.setVisibility(View.GONE);more.addView(extra);
        extra.addView(screen.text("الخصوصية والبيانات",16,DeviceScreen.BLUE));
        extra.addView(screen.text("يرسل التطبيق نوع الجهاز وإصدار أندرويد ونسبة البطارية وحالة سياسات الشركة وجرد التطبيقات. عند تفعيل سياسة تتبع الموقع، تُجمع إحداثيات الجهاز لغايات العمل وفق إعدادات الإدارة مع إشعار مستمر. لا يجمع التطبيق جهات الاتصال أو الصور الشخصية.",14,android.graphics.Color.WHITE));
        extra.addView(screen.text("تبقى القيود المطبّقة سارية عند انقطاع الإنترنت. وصول تنبيه تحديث لا يعني اكتمال تطبيقه؛ راجع نتيجة المزامنة. قد يؤخر نظام الهاتف التحديثات بسبب إعدادات توفير الطاقة.",14,android.graphics.Color.LTGRAY));
        diagnostics=screen.text("",13,android.graphics.Color.LTGRAY);diagnostics.setTextIsSelectable(true);extra.addView(diagnostics);
        expand.setOnClickListener(v->{boolean show=extra.getVisibility()!=View.VISIBLE;extra.setVisibility(show?View.VISIBLE:View.GONE);expand.setText(show?"إخفاء التفاصيل":"عرض الخصوصية والتشخيص");});
        screen.show();
        updateIdentityView();

    }

    @Override
    protected void onStart() {
        super.onStart();
        if (KioskController.enabled(this)) { KioskController.open(this); finish(); return; }
        getSharedPreferences("push-registration", MODE_PRIVATE)
                .registerOnSharedPreferenceChangeListener(pushStatusListener);
        requestNotificationPermissionIfNeeded();
        SyncEngine.setStatusListener((inProgress, message) -> {
            if (isDestroyed()) return;
            sync.setEnabled(!inProgress);
            if (message != null && !message.isEmpty()) {
                syncDetails = message;
                status.setText(message.length() > 240
                        ? "لم تكتمل بعض إجراءات المزامنة. اضغط عرض تفاصيل المزامنة لمعرفة التطبيقات أو الإجراءات المتأثرة."
                        : message);
            }
            updateIdentityView();
            if(resumeKiosk!=null)resumeKiosk.setVisibility(KioskController.inMaintenance(this)?View.VISIBLE:View.GONE);
        });
        attachAndSync("activity_onStart");
    }

    @Override
    protected void onStop() {
        getSharedPreferences("push-registration", MODE_PRIVATE)
                .unregisterOnSharedPreferenceChangeListener(pushStatusListener);
        SyncEngine.setStatusListener(null);
        super.onStop();
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return;
        }
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        if (notificationPermissionRequested) {
            return;
        }
        notificationPermissionRequested = true;
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_POST_NOTIFICATIONS);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_POST_NOTIFICATIONS) {
            boolean granted = grantResults != null
                    && grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            Log.i(TAG, "ui_post_notifications_permission: granted=" + granted);
            PushRegistration.refresh(this);
            updateIdentityView();
        }
    }

    private void attachAndSync(String trigger) {
        updateIdentityView();
        FirebaseUser user = FirebaseAuth.getInstance().getCurrentUser();
        if (user == null) {
            return;
        }
        if (PolicySyncService.canRunForegroundService(this)) {
            // Mark initial sync as handled by the explicit SyncEngine.requestSync below so no duplicate sync runs
            PolicySyncService.ensureStartedAfterVerifiedSync(this, "ui_" + trigger);
        }
        SyncEngine.requestSync(getApplicationContext(), "ui_" + trigger);
    }

    private void updateIdentityView() {
        if(identity==null)return;
        DevicePolicyManager dpm = (DevicePolicyManager) getSystemService(DEVICE_POLICY_SERVICE);
        boolean isOwner = dpm != null && dpm.isDeviceOwnerApp(getPackageName());
        String ownerText = isOwner ? "مفعّل" : "غير مفعّل";
        FirebaseUser user = FirebaseAuth.getInstance().getCurrentUser();
        deviceHeading.setText(KioskController.deviceName(this));
        register.setVisibility(user==null?View.VISIBLE:View.GONE);
        copy.setEnabled(user!=null);
        deviceUid.setText(user==null?"لم يُسجّل الجهاز بعد":user.getUid());
        if (user == null) {
            identity.setText("إدارة الجهاز: " + ownerText + "\nالتسجيل: غير مسجّل");
            diagnostics.setText("");
            return;
        }
        String uid = user.getUid();
        boolean approved = SyncEngine.isDeviceApproved(this, uid);
        boolean notifVisible = PolicySyncService.isNotificationVisible(this);
        String serviceStatus;
        if (PolicySyncService.isRunning()) {
            if (notifVisible) {
                serviceStatus = "نشطة — الإشعارات مسموحة («إدارة جهاز الشركة نشطة»)";
            } else {
                serviceStatus = "نشطة بالخلفية (الإشعارات غير مفعّلة للتطبيق أو القناة)";
            }
        } else if (isOwner && approved) {
            serviceStatus = "جاهزة للتشغيل";
        } else {
            serviceStatus = "بانتظار تفعيل الإدارة واعتماد الجهاز";
        }
        String push=PushRegistration.status(this);
        String pushSummary=push.startsWith("مسجّل")?"مسجّل لاستقبال التحديثات":push.startsWith("جارٍ")?"جارٍ التسجيل":push.startsWith("تعذر")?"تعذر التسجيل؛ راجع التفاصيل":"غير مسجّل";
        identity.setText("إدارة الجهاز: "+ownerText+"\nاعتماد الجهاز: "+(approved?"معتمد":"بانتظار الاعتماد")
                +"\nالمزامنة بالخلفية: "+serviceStatus+"\nتنبيهات التحديث: "+pushSummary);
        diagnostics.setText("حالة استقبال التحديثات التفصيلية:\n"+push);

    }
}

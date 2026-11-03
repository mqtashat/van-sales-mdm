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
    private TextView status;
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
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(32, 64, 32, 32);
        box.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);
        ScrollView scroll = new ScrollView(this);
        scroll.addView(box);
        setContentView(scroll);

        TextView heading = new TextView(this);
        heading.setText("إنجاز | تجربة إدارة الأجهزة");
        heading.setTextSize(25);
        box.addView(heading);

        TextView description = new TextView(this);
        description.setText(
                "نسخة إدارة أجهزة الشركة (0.5.0-pilot): منع مشاركة الإنترنت، والتحكم بتثبيت التطبيقات وإخفاء التطبيقات المحددة، وحماية شاشة الشركة. تبقى مكونات النظام الضرورية ومسؤولو الجهاز النشطون محميين. الإخفاء لا يحذف البيانات.\n\n"
                + "البيانات المرسلة: نوع الجهاز، إصدار أندرويد، نسبة البطارية، حالة السياسات والقيود، وجرد التطبيقات. عند تفعيل الإدارة لسياسة تتبع الموقع، تجمع الخدمة الأمامية المعلنة إحداثيات موقع الجهاز لغايات العمل وساعات الدوام بإشعار مستمر؛ ولا تجمع جهات اتصال أو صورًا شخصية.\n"
        );
        box.addView(description);

        identity = new TextView(this);
        identity.setTextIsSelectable(true);
        box.addView(identity);

        Button register = new Button(this);
        register.setText("تسجيل جهاز التجربة في Firebase");
        box.addView(register);
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
                    status.setText("فشل التسجيل. تأكد من تفعيل Anonymous Authentication والاتصال.\n"
                            + String.valueOf(task.getException()));
                }
            });
        });

        Button copy = new Button(this);
        copy.setText("نسخ معرّف الجهاز UID");
        box.addView(copy);
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

        sync = new Button(this);
        sync.setText("مزامنة والتحقق الآن");
        box.addView(sync);
        sync.setOnClickListener(v -> {
            Log.i(TAG, "ui_manual_sync_clicked");
            requestNotificationPermissionIfNeeded();
            SyncEngine.requestSync(getApplicationContext(), "ui_manual_button");
        });

        resumeKiosk = new Button(this);
        resumeKiosk.setText("إنهاء الصيانة والعودة لشاشة الشركة");
        resumeKiosk.setVisibility(KioskController.inMaintenance(this)?View.VISIBLE:View.GONE);
        box.addView(resumeKiosk);
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

        Button deprovisionBtn = new Button(this);
        deprovisionBtn.setText("حالة إدارة مسؤول الجهاز (Device Owner)");
        box.addView(deprovisionBtn);
        deprovisionBtn.setOnClickListener(v -> {
            DevicePolicyManager dpm = (DevicePolicyManager) getSystemService(DEVICE_POLICY_SERVICE);
            boolean isOwner = dpm != null && dpm.isDeviceOwnerApp(getPackageName());
            new AlertDialog.Builder(this)
                    .setTitle("إدارة مسؤول الجهاز (Device Owner)")
                    .setMessage(isOwner
                            ? "الجهاز مسجل كمسؤول جهاز معتمد (Device Owner).\n\n"
                            + "تنبيه الأمان والامتثال:\n"
                            + "وفق توثيق Android Enterprise الرسمي، لا يدعم النظام إنهاء إدارة الجهاز المدار بالكامل دون إعادة ضبط المصنع ومسح البيانات. لحماية بيانات وسجلات المبيعات من الفقدان، فإن استخدام دوال الاختبار التجريبية (clearDeviceOwnerApp) معطل في الإنتاج.\n\n"
                            + "لإجراء تعديلات أو صيانة مؤقتة دون مسح البيانات، يُرجى استخدام «وضع الصيانة» المعتمد من شاشة الشركة، أو أرشفة الجهاز من لوحة الإدارة."
                            : "الجهاز غير مسجل حالياً كمسؤول جهاز (Device Owner).")
                    .setPositiveButton("حسناً", null)
                    .show();
        });

        status = new TextView(this);
        status.setTextIsSelectable(true);
        box.addView(status);

        TextView note = new TextView(this);
        note.setText(
                "\nطريقة المزامنة بالخلفية:\n"
                + "• بعد تفعيل Device Owner وتسجيل الجهاز واعتماده في Firebase، يشغّل التطبيق خدمة أمامية («إدارة جهاز الشركة نشطة») للاستماع لتحديثات السياسة والتحقق منها من الخادم عبر SyncEngine.\n"
                + "• تصل تنبيهات تحديث السياسة عبر FCM بعد تسجيل الجهاز ونشر وظائف الخادم؛ التنبيه ليس تأكيدًا للتطبيق.\n"
                + "• يبقى WorkManager الدوري (كل 15 دقيقة أو أكثر بحسب النظام) مسارًا احتياطيًا، مع استعادة الخدمة بعد إعادة تشغيل الهاتف ضمن قيود أندرويد.\n"
                + "• يظل استقبال التحديثات بالخلفية معتمدًا على توفر الإنترنت وسياسات نظام الهاتف لتوفير الطاقة، بينما تبقى القيود المطبقة سارية حتى دون إنترنت.\n"
                + "• يستطيع المدير إنهاء الصيانة والعودة لشاشة الشركة من هذا التطبيق؛ الحظر ومنع المشاركة يبقيان حسب سياسة الإدارة."
        );
        box.addView(note);
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
                status.setText(message);
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
        DevicePolicyManager dpm = (DevicePolicyManager) getSystemService(DEVICE_POLICY_SERVICE);
        boolean isOwner = dpm != null && dpm.isDeviceOwnerApp(getPackageName());
        String ownerText = isOwner ? "مفعّل" : "غير مفعّل";
        FirebaseUser user = FirebaseAuth.getInstance().getCurrentUser();
        if (user == null) {
            identity.setText("Device Owner: " + ownerText + "\nلم يسجّل الجهاز بعد.");
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
            serviceStatus = "بانتظار استيفاء الشروط (Device Owner + اعتماد الجهاز)";
        }
        identity.setText(
                "Device Owner: " + ownerText
                + "\nخدمة المزامنة بالخلفية: " + serviceStatus
                + "\nاستقبال FCM: " + PushRegistration.status(this)
                + "\nUID:\n" + uid + "\n"
        );
    }
}

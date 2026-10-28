package com.company.mdmagent;

import android.app.Activity;
import android.app.admin.DevicePolicyManager;
import android.content.*;
import android.os.Bundle;
import android.view.View;
import android.widget.*;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.firestore.*;

public class MainActivity extends Activity {
    private TextView identity, status;
    private Button sync;
    private ListenerRegistration listener;
    private boolean active;
    private boolean busy;
    private boolean pending;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(32, 64, 32, 32);
        box.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);
        ScrollView scroll = new ScrollView(this);
        scroll.addView(box);
        setContentView(scroll);
        TextView heading = new TextView(this);
        heading.setText("إنجاز | تجربة إدارة الأجهزة"); heading.setTextSize(25); box.addView(heading);
        TextView description = new TextView(this);
        description.setText("نسخة اختبار لجهاز واحد: منع مشاركة الإنترنت وحظر تطبيقات محمّلة تحددها الإدارة، بعد اعتماد الجهاز وتفعيل Device Owner. لا تمسح البيانات ولا تزيل Family Link. تطبيقات النظام محمية في هذه التجربة.\n\nترسل: نوع الجهاز، إصدار أندرويد، البطارية، حالة الصلاحية والسياسة ووقت المزامنة. لا تجمع موقعًا أو صورًا أو جهات اتصال.\n");
        box.addView(description);
        identity = new TextView(this); identity.setTextIsSelectable(true); box.addView(identity);
        Button register = new Button(this); register.setText("تسجيل جهاز التجربة في Firebase"); box.addView(register);
        register.setOnClickListener(v -> {
            if (FirebaseAuth.getInstance().getCurrentUser() != null) { attach(); return; }
            register.setEnabled(false);
            FirebaseAuth.getInstance().signInAnonymously().addOnCompleteListener(this, task -> {
                register.setEnabled(true);
                if (task.isSuccessful()) attach();
                else status.setText("فشل التسجيل. تأكد من تفعيل Anonymous Authentication والاتصال.\n" + String.valueOf(task.getException()));
            });
        });
        Button copy = new Button(this); copy.setText("نسخ معرّف الجهاز UID"); box.addView(copy);
        copy.setOnClickListener(v -> {
            if (FirebaseAuth.getInstance().getCurrentUser() != null) {
                ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("Device UID", FirebaseAuth.getInstance().getCurrentUser().getUid()));
                Toast.makeText(this, "تم النسخ", Toast.LENGTH_SHORT).show();
            }
        });
        sync = new Button(this); sync.setText("مزامنة والتحقق الآن"); box.addView(sync);
        sync.setOnClickListener(v -> refresh());
        status = new TextView(this); status.setTextIsSelectable(true); box.addView(status);
        TextView note = new TextView(this);
        note.setText("\nعند إغلاق الشاشة: مزامنة دورية كل 15 دقيقة أو أكثر بحسب أندرويد والبطارية. ليست خدمة فورية أو تتبعًا حيًا. القيد المطبق يبقى دون إنترنت.\nلا توجد أزرار محلية لفك القيود؛ المسؤول يغيّر السياسة في Firebase.");
        box.addView(note);
    }

    @Override protected void onStart() { super.onStart(); active = true; attach(); }
    @Override protected void onStop() {
        active = false;
        if (listener != null) { listener.remove(); listener = null; }
        super.onStop();
    }
    private void attach() {
        if (!active) return;
        DevicePolicyManager dpm = (DevicePolicyManager) getSystemService(DEVICE_POLICY_SERVICE);
        String owner = dpm.isDeviceOwnerApp(getPackageName()) ? "مفعّل" : "غير مفعّل";
        if (FirebaseAuth.getInstance().getCurrentUser() == null) {
            identity.setText("Device Owner: " + owner + "\nلم يسجّل الجهاز بعد."); return;
        }
        String uid = FirebaseAuth.getInstance().getCurrentUser().getUid();
        identity.setText("Device Owner: " + owner + "\nUID:\n" + uid + "\n");
        if (listener != null) listener.remove();
        listener = FirebaseFirestore.getInstance().collection("policies").document(uid)
                .addSnapshotListener((snapshot, error) -> {
                    if (!active) return;
                    if (error != null) status.setText("بانتظار اعتماد الجهاز أو نشر قواعد Firebase. اضغط مزامنة بعد الإعداد.");
                    else if (snapshot != null && !snapshot.getMetadata().isFromCache()) refresh();
                });
        refresh();
    }
    private void refresh() {
        if (busy) { pending = true; return; }
        busy = true; sync.setEnabled(false); status.setText("جارٍ التحقق من الخادم…");
        Context app = getApplicationContext();
        AgentApp.SYNC.execute(() -> {
            String result;
            try { result = SyncEngine.sync(app); }
            catch (Exception ex) { result = "تعذر إكمال المزامنة؛ لا تفترض تطبيق سياسة جديدة.\n" + String.valueOf(ex.getMessage()); }
            String message = result;
            runOnUiThread(() -> {
                if (isDestroyed()) return;
                busy = false; sync.setEnabled(true); status.setText(message);
                if (pending && active) { pending = false; refresh(); }
            });
        });
    }
}

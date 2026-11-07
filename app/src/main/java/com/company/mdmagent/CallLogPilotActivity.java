package com.company.mdmagent;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.admin.DevicePolicyManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.OperationCanceledException;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Explicitly activated, maintenance-only local compatibility test, not fleet monitoring. */
public final class CallLogPilotActivity extends Activity {
    private static final int REQUEST_CALL_LOG = 3101;
    private static final String PREFS = "call-log-local-pilot";
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private TextView state, output;
    private Button start, read, stop;
    private CancellationSignal cancellation;
    private int generation;
    private boolean permissionRequestedWithConsent;

    static boolean canAccess(Context context) {
        DevicePolicyManager dpm = (DevicePolicyManager) context.getSystemService(DEVICE_POLICY_SERVICE);
        if (dpm == null || !dpm.isDeviceOwnerApp(context.getPackageName())
                || !KioskController.inMaintenance(context) || KioskController.enabled(context)) return false;
        String uid = SyncEngine.getCurrentAuthenticatedUid();
        return uid != null && SyncEngine.isDeviceApproved(context, uid)
                && KioskController.inMaintenance(context) && !KioskController.enabled(context);
    }
    private SharedPreferences prefs() { return getSharedPreferences(PREFS, MODE_PRIVATE); }
    private boolean permitted() {
        return checkSelfPermission(Manifest.permission.READ_CALL_LOG) == PackageManager.PERMISSION_GRANTED;
    }
    private int bootCount() {
        return Settings.Global.getInt(getContentResolver(), Settings.Global.BOOT_COUNT, -1);
    }
    private boolean sessionActive() {
        SharedPreferences p = prefs();
        return bootCount() >= 0 && p.getInt("boot", -2) == bootCount()
                && CallLogPilotSession.valid(p.getLong("start", 0), p.getLong("elapsed", -1),
                p.getString("uid", ""), SyncEngine.getCurrentAuthenticatedUid(),
                System.currentTimeMillis(), SystemClock.elapsedRealtime());
    }
    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (!canAccess(this)) { finish(); return; }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        DeviceScreen screen = new DeviceScreen(this);
        screen.title("اختبار المكالمات", 24, Color.WHITE);
        LinearLayout card = screen.card("تجربة محلية على جهاز الشركة");
        card.addView(screen.text("تقرأ هذه التجربة الرقم واتجاه المكالمة ووقتها ومدتها من سجل الهاتف، للمكالمات التي تبدأ بعد تفعيل الاختبار فقط. لا تسجّل الصوت ولا تقرأ الرسائل أو جهات الاتصال ولا ترسل أي سجل للوحة أو الخادم. استخدم أرقام اختبار وافق أصحابها على التجربة.", 15, Color.WHITE));
        card.addView(screen.text("الاختبار يدوي وليس مراقبة خلفية. ينتهي بعد 24 ساعة أو إعادة تشغيل الهاتف، ويمكن إيقافه فورًا. قد لا تظهر مكالمات تطبيقات الإنترنت في سجل النظام.", 14, Color.LTGRAY));
        state = screen.text("", 14, DeviceScreen.BLUE); card.addView(state);
        start = screen.button("تفعيل اختبار المكالمات الجديدة"); card.addView(start);
        start.setOnClickListener(v -> {
            if (!canAccess(this)) { finish(); return; }
            new AlertDialog.Builder(this).setTitle("بدء اختبار محلي معلن")
                    .setMessage("أؤكد أن هذا جهاز الشركة وأن التجربة معلنة. ستُعرض أرقام المكالمات الجديدة ووقتها ومدتها على هذه الشاشة فقط. لن يُستورد السجل السابق.")
                    .setNegativeButton("إلغاء", null)
                    .setPositiveButton("بدء الاختبار", (dialog, which) -> {
                        if (!canAccess(this)) { finish(); return; }
                        if (permitted()) beginSession();
                        else {
                            permissionRequestedWithConsent = true;
                            requestPermissions(new String[]{Manifest.permission.READ_CALL_LOG}, REQUEST_CALL_LOG);
                        }
                    }).show();
        });
        read = screen.button("قراءة مكالمات الاختبار الآن"); card.addView(read);
        read.setOnClickListener(v -> readCalls());
        stop = screen.button("إيقاف الاختبار ومسح العرض"); card.addView(stop);
        stop.setOnClickListener(v -> {
            cancelRead();
            prefs().edit().clear().apply();
            output.setText("تم إيقاف الاختبار. لم يُحذف أي شيء من سجل الهاتف.");
            updateState();
        });
        LinearLayout result = screen.card("النتيجة المحلية — آخر 100 مكالمة اختبار كحد أقصى");
        output = screen.text("ابدأ الاختبار، أجرِ مكالمات تجريبية، ثم ارجع واقرأ النتيجة.", 14, Color.WHITE);
        result.addView(output);
        Button back = screen.button("العودة إلى الصيانة"); screen.footer.addView(back);
        back.setOnClickListener(v -> finish());
        screen.show();
    }
    @Override protected void onResume() {
        super.onResume();
        if (!canAccess(this)) { finish(); return; }
        updateState();
    }
    private void updateState() {
        if (state == null) return;
        boolean active = sessionActive();
        if (!active) prefs().edit().clear().apply();
        state.setText("إذن قراءة السجل: " + (permitted() ? "ممنوح" : "غير ممنوح")
                + "\nالاختبار: " + (active ? "مفعّل منذ " + format(prefs().getLong("start", 0)) : "متوقف")
                + "\nإرسال للوحة: غير مفعّل في هذه التجربة");
        start.setEnabled(!active);
        read.setEnabled(active && permitted() && cancellation == null);
        stop.setEnabled(active);
    }
    private void beginSession() {
        if (!canAccess(this) || !permitted()) return;
        cancelRead();
        if (bootCount() < 0 || !prefs().edit().clear()
                .putLong("start", System.currentTimeMillis())
                .putLong("elapsed", SystemClock.elapsedRealtime())
                .putInt("boot", bootCount()).putString("uid", SyncEngine.getCurrentAuthenticatedUid()).commit()) {
            output.setText("تعذر بدء جلسة الاختبار؛ لم تتم قراءة سجل المكالمات.");
        } else {
            output.setText("بدأ الاختبار. أجرِ مكالمة صادرة، واستقبل مكالمة، واترك أخرى فائتة؛ ثم اضغط قراءة مكالمات الاختبار الآن.");
        }
        updateState();
    }
    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_CALL_LOG) return;
        boolean consent = permissionRequestedWithConsent;
        permissionRequestedWithConsent = false;
        if (!canAccess(this)) { finish(); return; }
        if (consent && permitted()) beginSession();
        else {
            output.setText("لم يُمنح إذن سجل المكالمات؛ لم تتم أي قراءة. قد تمنع طريقة تثبيت التطبيق الإذن المقيّد. أرسل حالة الإذن لمسؤول النظام؛ لا حاجة لضبط المصنع أو تغيير تطبيق الاتصال.");
            updateState();
        }
    }
    private void readCalls() {
        if (!canAccess(this)) { finish(); return; }
        if (!sessionActive() || !permitted()) {
            output.setText("الجلسة غير فعّالة أو إذن السجل غير متاح. لم تتم القراءة."); updateState(); return;
        }
        cancelRead();
        final int requestGeneration = generation;
        final long since = prefs().getLong("start", 0);
        final long now = System.currentTimeMillis();
        final CancellationSignal signal = new CancellationSignal();
        cancellation = signal;
        output.setText("جارٍ قراءة سجل الاختبار محليًا..."); updateState();
        worker.execute(() -> {
            String message;
            try {
                if (!canAccess(this) || !sessionActive()) return;
                CallLogPilotReader.Result data = CallLogPilotReader.read(this, since, now, signal);
                StringBuilder text = new StringBuilder("نجحت قراءة السجل. المكالمات المعروضة: ").append(data.rows.size());
                if (data.partial) text.append("\nعرض جزئي: توجد أكثر من 100 مكالمة ضمن الاختبار.");
                if (data.rows.isEmpty()) text.append("\nلا توجد مكالمات مسجلة منذ بدء الاختبار. أنهِ مكالمة تجريبية وانتظر حفظها في سجل الهاتف ثم أعد القراءة.");
                for (CallLogPilotReader.Row row : data.rows) {
                    text.append("\n\n").append(row.number).append("\n")
                            .append(CallLogPilotReader.typeLabel(row.type)).append(" — ").append(format(row.startedAt))
                            .append("\nالمدة المسجلة: ").append(row.duration < 0 ? "غير متاحة" : row.duration + " ثانية");
                }
                text.append("\n\nهذه بيانات سجل الهاتف؛ مدة صفر لا تثبت وحدها الرد أو عدم الرد. لا يوجد إرسال للوحة.");
                message = text.toString();
            } catch (OperationCanceledException ex) { return;
            } catch (SecurityException ex) {
                message = "رفض النظام قراءة سجل المكالمات. لم تُرسل أي بيانات. تحقق من إذن السجل وطريقة التثبيت.";
            } catch (RuntimeException ex) {
                // No exception message/stack logging: OEM errors may include phone numbers.
                message = "تعذر قراءة سجل الهاتف (" + ex.getClass().getSimpleName() + "). هذه ليست نتيجة سجل فارغ.";
            }
            final String finalMessage = message;
            runOnUiThread(() -> {
                if (isDestroyed() || isFinishing() || requestGeneration != generation || signal.isCanceled()) return;
                cancellation = null;
                if (!canAccess(this) || !sessionActive() || !permitted()) {
                    output.setText("انتهت صلاحية الوصول؛ أُخفيت نتيجة الاختبار."); updateState(); return;
                }
                output.setText(finalMessage); updateState();
            });
        });
    }
    private void cancelRead() {
        generation++;
        if (cancellation != null) cancellation.cancel();
        cancellation = null;
    }
    @Override protected void onStop() {
        cancelRead();
        if (output != null) output.setText("أُخفي العرض عند مغادرة الشاشة. اضغط قراءة مكالمات الاختبار الآن لتحديثه.");
        super.onStop();
    }
    @Override protected void onDestroy() {
        cancelRead(); worker.shutdownNow(); super.onDestroy();
    }
    private static String format(long epochMs) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", new Locale("ar", "JO"));
        f.setTimeZone(TimeZone.getTimeZone("Asia/Amman"));
        return f.format(new Date(epochMs)) + " (عمّان)";
    }
}

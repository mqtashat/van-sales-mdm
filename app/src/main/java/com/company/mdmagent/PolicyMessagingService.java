package com.company.mdmagent;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.WorkManager;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseUser;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

/** Data-only wake-up hints. No policy fields from a push are ever enforced. */
public class PolicyMessagingService extends FirebaseMessagingService {
    private static final String CHANNEL = "policy-updates";

    static boolean validHint(Map<String, String> data, String uid) {
        return uid != null && uid.equals(data.get("uid")) && "policy_sync".equals(data.get("type"));
    }

    static boolean canShowUpdateNotification(Context context) {
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return false;
        NotificationChannel channel = new NotificationChannel(CHANNEL, "تحديث سياسة جهاز الشركة", NotificationManager.IMPORTANCE_DEFAULT);
        channel.setSound(null, null);
        channel.enableVibration(false);
        nm.createNotificationChannel(channel);
        return nm.areNotificationsEnabled()
                && (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
                && nm.getNotificationChannel(CHANNEL).getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    @Override public void onNewToken(@NonNull String token) {
        PushRegistration.invalidate(this);
        PushRegistration.refresh(this);
    }

    @Override public void onMessageReceived(@NonNull RemoteMessage message) {
        FirebaseUser user = FirebaseAuth.getInstance().getCurrentUser();
        if (!validHint(message.getData(), user == null ? null : user.getUid())
                || !PolicySyncService.isDeviceOwnerActive(this)) return;
        Log.i(SyncEngine.TAG, "fcm_policy_hint_received: priority=" + message.getPriority());
        // A high-priority hint corresponds to this visible administrative notice.
        // The notice says received, NEVER applied. Only deviceStatus confirms enforcement.
        if (canShowUpdateNotification(this)) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            PendingIntent open = PendingIntent.getActivity(this, 31, new Intent(this, MainActivity.class),
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            nm.notify(31, new Notification.Builder(this, CHANNEL)
                    .setSmallIcon(android.R.drawable.ic_lock_lock)
                    .setContentTitle("تحديث سياسة جهاز الشركة")
                    .setContentText("وصل طلب من الإدارة؛ جارٍ التحقق من السياسة المعتمدة.")
                    .setContentIntent(open).setAutoCancel(true).build());
        }
        // Foreground service owns ongoing execution; callback itself never waits on network.
        PolicySyncService.ensureStarted(this, "fcm_received");
        SyncEngine.requestSync(this, "fcm_received");
        OneTimeWorkRequest.Builder backup = new OneTimeWorkRequest.Builder(SyncWorker.class)
                .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build());
        if (message.getPriority() == RemoteMessage.PRIORITY_HIGH) {
            backup.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST);
        }
        WorkManager.getInstance(this).enqueueUniqueWork("policy-push-sync", ExistingWorkPolicy.KEEP, backup.build());
    }
}

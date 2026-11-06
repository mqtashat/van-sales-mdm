package com.company.mdmagent;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import com.google.firebase.firestore.FirebaseFirestore;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Foreground location tracking service for company-owned devices.
 * Features:
 * - Constant notification with clear enterprise disclosure.
 * - Respects work hours schedule (pauses GPS outside schedule without stopping the service).
 * - Enqueues captured points in persistent offline queue.
 * - Adjusts sampling based on device movement.
 */
public class PolicyLocationService extends Service implements LocationListener {
    public static final String TAG = "InjazLocationService";
    public static final String CHANNEL_ID = "injaz_location_tracking";
    public static final int NOTIFICATION_ID = 3001;

    private static final AtomicBoolean RUNNING = new AtomicBoolean(false);
    private LocationManager locationManager;
    private Handler handler;
    private Runnable scheduleCheckRunnable;
    private Runnable acquisitionTimeout;
    private boolean acquiring;
    private long lastDrainElapsed;
    private final LocationQualityFilter quality = new LocationQualityFilter();

    public static boolean isServiceRunning() {
        return RUNNING.get();
    }

    public static void startIfPolicyEnabled(Context context) {
        LocationPolicy policy = LocationPolicy.getLocal(context);
        if (policy.enabled) {
            Intent intent = new Intent(context, PolicyLocationService.class);
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent);
                } else {
                    context.startService(intent);
                }
            } catch (Exception ex) {
                Log.w(TAG, "failed_to_start_location_service: " + ex.getMessage());
            }
        }
    }

    public static void stopService(Context context) {
        context.stopService(new Intent(context, PolicyLocationService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        handler = new Handler(Looper.getMainLooper());
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        RUNNING.set(true);
        Notification notification = buildForegroundNotification("خدمة تتبع موقع جهاز الشركة قيد العمل وفق سياسة الإدارة");

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }

        startScheduleChecker();
        return START_STICKY;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "تتبع موقع أجهزة الشركة",
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("إشعار معلن يوضح تشغيل خدمة الموقع لأجهزة الشركة المعتمدة");
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.createNotificationChannel(channel);
            }
        }
    }

    private Notification buildForegroundNotification(String statusText) {
        Intent launchIntent = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(
                this, 0, launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0)
        );

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
        }

        builder.setContentTitle("إنجاز | تتبع موقع جهاز الشركة")
                .setContentText(statusText)
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setContentIntent(pi)
                .setOngoing(true);

        return builder.build();
    }

    private void startScheduleChecker() {
        if (scheduleCheckRunnable != null) return; // Repeated sync must not restart sampling.

        scheduleCheckRunnable = new Runnable() {
            @Override
            public void run() {
                try {
                    evaluateAndSample();
                } catch (Exception ex) {
                    Log.w(TAG, "evaluateAndSample error: " + ex.getMessage());
                }

                LocationPolicy policy = LocationPolicy.getLocal(PolicyLocationService.this);
                if (!policy.enabled) {
                    stopSelf();
                    return;
                }

                long delayMs = quality.isMoving() ? 30_000L : 60_000L;
                handler.postDelayed(this, Math.max(15_000L, delayMs));
            }
        };

        handler.post(scheduleCheckRunnable);
    }

    private void evaluateAndSample() {
        LocationPolicy policy = LocationPolicy.getLocal(this);
        if (!policy.enabled) {
            stopSelf();
            return;
        }

        long now = System.currentTimeMillis();
        boolean withinSchedule = policy.shouldCollectAt(now);

        if (!withinSchedule) {
            // Outside work hours schedule: do NOT sample location!
            updateNotification("التتبع متوقف حاليًا: خارج ساعات العمل المحددة من الإدارة");
            removeLocationUpdates();
            quality.reset();
            return;
        }

        String activeUid = SyncEngine.getCurrentAuthenticatedUid();
        if (activeUid == null || !SyncEngine.isDeviceApproved(this, activeUid)) {
            removeLocationUpdates(); quality.reset(); return;
        }
        drainIfDue(activeUid);
        updateNotification("تتبع الموقع نشط: ضمن ساعات العمل المقررة");
        requestSingleFreshLocation();
    }

    private void updateNotification(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            nm.notify(NOTIFICATION_ID, buildForegroundNotification(text));
        }
    }

    private void requestSingleFreshLocation() {
        if (locationManager == null || acquiring) return;
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "location_permission_missing");
            return;
        }

        try {
            boolean gpsAvailable = locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER);
            boolean networkAvailable = locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);

            acquiring = true;
            acquisitionTimeout = () -> {
                removeLocationUpdates();
                updateNotification("لم تتوفر قراءة دقيقة حديثة؛ لم تُسجّل نقطة جديدة");
            };
            handler.postDelayed(acquisitionTimeout, 25_000L);
            if (gpsAvailable) {
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 5000L, 0f, this);
            }
            if (networkAvailable) {
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 5000L, 0f, this);
            }
        } catch (Exception ex) {
            removeLocationUpdates();
            Log.w(TAG, "requestLocationUpdates failed: " + ex.getMessage());
        }
    }

    private void removeLocationUpdates() {
        acquiring = false;
        if (acquisitionTimeout != null) handler.removeCallbacks(acquisitionTimeout);
        acquisitionTimeout = null;
        if (locationManager != null) {
            try {
                locationManager.removeUpdates(this);
            } catch (Exception ignored) {}
        }
    }

    @Override
    public void onLocationChanged(Location location) {
        if (location == null || !acquiring) return;

        // Re-verify tracking enabled and schedule compliance upon coordinate arrival
        LocationPolicy policy = LocationPolicy.getLocal(this);
        long now = System.currentTimeMillis();
        if (!policy.enabled || !policy.shouldCollectAt(now)) {
            removeLocationUpdates();
            quality.reset();
            Log.i(TAG, "location_dropped_outside_schedule_or_disabled");
            return;
        }

        long recordedAt = location.getTime();
        long ageMs = (SystemClock.elapsedRealtimeNanos() - location.getElapsedRealtimeNanos()) / 1_000_000L;
        if (!LocationQualityFilter.valid(location.getLatitude(), location.getLongitude(),
                location.hasAccuracy() ? location.getAccuracy() : Float.NaN,
                ageMs, recordedAt, now)) return; // Keep acquiring after bad first fix.
        removeLocationUpdates();
        if (!quality.accept(location.getLatitude(), location.getLongitude(), location.getAccuracy(),
                SystemClock.elapsedRealtime())) {
            updateNotification("قراءة حديثة؛ لا توجد حركة مؤكدة تستدعي نقطة جديدة");
            return;
        }

        String uid = SyncEngine.getCurrentAuthenticatedUid();
        if (uid == null || uid.isEmpty() || !SyncEngine.isDeviceApproved(this, uid)) {
            Log.w(TAG, "location_dropped_device_unauthenticated_or_unapproved");
            return;
        }

        // Obtain battery level
        BatteryManager bm = (BatteryManager) getSystemService(Context.BATTERY_SERVICE);
        int battery = bm != null ? bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) : 0;

        // Deterministic point ID for safe idempotent offline replay
        String pointId = "pt_" + recordedAt + "_" + String.format(java.util.Locale.US, "%.5f_%.5f", location.getLatitude(), location.getLongitude()).replace('.', '_').replace('-', 'm');

        LocationQueue.Point p = new LocationQueue.Point(
                pointId,
                recordedAt,
                location.getLatitude(),
                location.getLongitude(),
                location.getAccuracy(),
                location.hasSpeed() ? location.getSpeed() : 0f,
                battery
        );

        LocationQueue.enqueue(this, uid, p);
        // Do NOT log latitude or longitude to public logs
        Log.i(TAG, "location_point_captured_safely: acc=" + p.accuracyMeters + " battery=" + battery);

        drainIfDue(uid);
    }

    private void drainIfDue(String uid) {
        long elapsed = SystemClock.elapsedRealtime();
        if (lastDrainElapsed != 0 && elapsed - lastDrainElapsed < 60_000) return;
        lastDrainElapsed = elapsed;
        AgentApp.SYNC.execute(() -> {
            try {
                LocationQueue.drainToFirestore(this, FirebaseFirestore.getInstance(), uid, 20);
            } catch (Exception ex) {
                Log.w(TAG, "queue_drain_notice: " + ex.getMessage());
            }
        });
    }

    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {}

    @Override
    public void onProviderEnabled(String provider) {}

    @Override
    public void onProviderDisabled(String provider) {}

    @Override
    public void onDestroy() {
        super.onDestroy();
        RUNNING.set(false);
        removeLocationUpdates();
        if (handler != null && scheduleCheckRunnable != null) {
            handler.removeCallbacks(scheduleCheckRunnable);
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}

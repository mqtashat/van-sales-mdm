package com.company.mdmagent;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;

/**
 * Independent enterprise device location policy.
 * Controls:
 * 1. Global location switch enforcement (dpm.setLocationEnabled)
 * 2. Location configuration restriction (DISALLOW_CONFIG_LOCATION)
 * 3. Foreground location tracking schedule (continuous vs work hours)
 * 4. Sampling interval in seconds
 */
public final class LocationPolicy {
    public static final String PREFS_NAME = "injaz-location-policy";
    public static final String KEY_REVISION = "revision";
    public static final String KEY_ENABLED = "enabled";
    public static final String KEY_MODE = "mode";
    public static final String KEY_START_TIME = "start_time";
    public static final String KEY_END_TIME = "end_time";
    public static final String KEY_DAYS = "work_days";
    public static final String KEY_INTERVAL = "sampling_interval_seconds";

    public final long revision;
    public final boolean enabled;
    public final String mode; // "continuous" or "work_hours"
    public final String startTime; // "HH:mm" e.g. "08:00"
    public final String endTime;   // "HH:mm" e.g. "18:00"
    public final Set<Integer> workDays; // 1 = Sunday, 2 = Monday, ... 7 = Saturday (Calendar.SUNDAY..SATURDAY)
    public final int samplingIntervalSeconds;

    public LocationPolicy(long revision, boolean enabled, String mode,
                          String startTime, String endTime,
                          Set<Integer> workDays, int samplingIntervalSeconds) {
        this.revision = revision;
        this.enabled = enabled;
        this.mode = (mode != null && mode.equals("work_hours")) ? "work_hours" : "continuous";
        this.startTime = (startTime != null && startTime.matches("^\\d{2}:\\d{2}$")) ? startTime : "08:00";
        this.endTime = (endTime != null && endTime.matches("^\\d{2}:\\d{2}$")) ? endTime : "18:00";
        this.workDays = workDays != null ? workDays : Set.of(Calendar.SUNDAY, Calendar.MONDAY, Calendar.TUESDAY, Calendar.WEDNESDAY, Calendar.THURSDAY);
        this.samplingIntervalSeconds = Math.max(30, Math.min(3600, samplingIntervalSeconds > 0 ? samplingIntervalSeconds : 300));
    }

    public static LocationPolicy parse(Map<String, Object> data, long currentRevision) {
        if (data == null) {
            throw new IllegalArgumentException("وثيقة سياسة الموقع فارغة");
        }
        Object sv = data.get("schema_version");
        if (!(sv instanceof Number) || ((Number) sv).intValue() != 1) {
            throw new IllegalArgumentException("إصدار مخطط سياسة الموقع غير صالح");
        }
        Object revObj = data.get("revision");
        if (!(revObj instanceof Number)) {
            throw new IllegalArgumentException("رقم إصدار سياسة الموقع غير صالح");
        }
        long rev = ((Number) revObj).longValue();
        if (rev < 1) {
            throw new IllegalArgumentException("رقم الإصدار يجب أن يكون موجبًا");
        }
        if (rev < currentRevision) {
            throw new IllegalArgumentException("إصدار سياسة الموقع أقدم من الإصدار الحالي");
        }
        Object enabledObj = data.get("enabled");
        if (!(enabledObj instanceof Boolean)) {
            throw new IllegalArgumentException("حقل تفعيل الموقع يجب أن يكون Boolean");
        }
        boolean enabled = (Boolean) enabledObj;

        String mode = "continuous";
        Object modeObj = data.get("mode");
        if (modeObj instanceof String) {
            mode = (String) modeObj;
        }

        String start = "08:00";
        String end = "18:00";
        Set<Integer> days = new HashSet<>(Set.of(Calendar.SUNDAY, Calendar.MONDAY, Calendar.TUESDAY, Calendar.WEDNESDAY, Calendar.THURSDAY));

        Object whObj = data.get("work_hours");
        if (whObj instanceof Map) {
            Map<?, ?> wh = (Map<?, ?>) whObj;
            if (wh.get("start") instanceof String) start = (String) wh.get("start");
            if (wh.get("end") instanceof String) end = (String) wh.get("end");
            if (wh.get("days") instanceof List) {
                days.clear();
                for (Object d : (List<?>) wh.get("days")) {
                    if (d instanceof Number) {
                        int val = ((Number) d).intValue();
                        // 0 = Sunday (Calendar.SUNDAY=1), etc. or 1-7
                        int calDay = (val >= 1 && val <= 7) ? val : (val == 0 ? Calendar.SUNDAY : val + 1);
                        days.add(calDay);
                    }
                }
            }
        }

        // Dashboard documents use flat fields. Keep legacy work_hours as fallback.
        if (data.get("start_time") instanceof String) start = (String) data.get("start_time");
        if (data.get("end_time") instanceof String) end = (String) data.get("end_time");
        if (data.get("work_days") instanceof List) {
            days.clear();
            for (Object day : (List<?>) data.get("work_days")) {
                if (!(day instanceof Number) || ((Number) day).doubleValue() != ((Number) day).intValue()
                        || ((Number) day).intValue() < Calendar.SUNDAY || ((Number) day).intValue() > Calendar.SATURDAY) {
                    throw new IllegalArgumentException("أيام العمل يجب أن تكون من 1 إلى 7");
                }
                days.add(((Number) day).intValue());
            }
        }

        int interval = 300;
        Object intObj = data.get("sampling_interval_seconds");
        if (intObj instanceof Number) {
            interval = ((Number) intObj).intValue();
        }

        return new LocationPolicy(rev, enabled, mode, start, end, days, interval);
    }

    /**
     * Checks if a given timestamp falls within active collection schedule.
     */
    public boolean shouldCollectAt(long timestampMs) {
        if (!enabled) return false;
        if ("continuous".equals(mode)) return true;

        Calendar cal = Calendar.getInstance(TimeZone.getDefault());
        cal.setTimeInMillis(timestampMs);

        int dayOfWeek = cal.get(Calendar.DAY_OF_WEEK);

        int currentMinutes = cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE);
        int startMinutes = parseMinutes(startTime);
        int endMinutes = parseMinutes(endTime);

        if (startMinutes <= endMinutes) {
            // Standard daytime schedule (e.g. 08:00 to 18:00)
            return workDays.contains(dayOfWeek) && currentMinutes >= startMinutes && currentMinutes <= endMinutes;
        } else {
            // Night shift crossing midnight (e.g. 20:00 to 04:00)
            if (currentMinutes >= startMinutes) {
                return workDays.contains(dayOfWeek); // Shift must start on an enabled day
            }
            if (currentMinutes <= endMinutes) {
                // After midnight; check if yesterday was an active work day
                Calendar prev = (Calendar) cal.clone();
                prev.add(Calendar.DAY_OF_YEAR, -1);
                int prevDay = prev.get(Calendar.DAY_OF_WEEK);
                return workDays.contains(prevDay);
            }
            return false;
        }
    }

    private static int parseMinutes(String time) {
        try {
            String[] parts = time.split(":");
            return Integer.parseInt(parts[0]) * 60 + Integer.parseInt(parts[1]);
        } catch (Exception ex) {
            return 0;
        }
    }

    public static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public static LocationPolicy getLocal(Context context) {
        SharedPreferences p = prefs(context);
        long rev = p.getLong(KEY_REVISION, 0L);
        boolean enabled = p.getBoolean(KEY_ENABLED, false);
        String mode = p.getString(KEY_MODE, "continuous");
        String start = p.getString(KEY_START_TIME, "08:00");
        String end = p.getString(KEY_END_TIME, "18:00");
        Set<String> dayStrings = p.getStringSet(KEY_DAYS, null);
        Set<Integer> days = new HashSet<>();
        if (dayStrings != null) {
            for (String s : dayStrings) {
                try { days.add(Integer.parseInt(s)); } catch (Exception ignored) {}
            }
        }
        if (dayStrings == null) {
            days.addAll(Set.of(Calendar.SUNDAY, Calendar.MONDAY, Calendar.TUESDAY, Calendar.WEDNESDAY, Calendar.THURSDAY));
        }
        int interval = p.getInt(KEY_INTERVAL, 300);
        return new LocationPolicy(rev, enabled, mode, start, end, days, interval);
    }

    public static void saveLocal(Context context, LocationPolicy policy) {
        if (policy == null) return;
        Set<String> dayStrings = new HashSet<>();
        for (Integer d : policy.workDays) {
            dayStrings.add(String.valueOf(d));
        }
        boolean ok = prefs(context).edit()
                .putLong(KEY_REVISION, policy.revision)
                .putBoolean(KEY_ENABLED, policy.enabled)
                .putString(KEY_MODE, policy.mode)
                .putString(KEY_START_TIME, policy.startTime)
                .putString(KEY_END_TIME, policy.endTime)
                .putStringSet(KEY_DAYS, dayStrings)
                .putInt(KEY_INTERVAL, policy.samplingIntervalSeconds)
                .commit();
        if (!ok) {
            throw new IllegalStateException("تعذر حفظ سياسة الموقع محليًا");
        }
    }
}

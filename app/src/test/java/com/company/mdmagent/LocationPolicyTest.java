package com.company.mdmagent;

import org.junit.Test;
import java.util.Calendar;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import static org.junit.Assert.*;

public class LocationPolicyTest {

    private Map<String, Object> validDoc(long rev, boolean enabled, String mode) {
        Map<String, Object> map = new HashMap<>();
        map.put("schema_version", 1L);
        map.put("revision", rev);
        map.put("enabled", enabled);
        map.put("mode", mode);
        map.put("start_time", "08:00");
        map.put("end_time", "18:00");
        map.put("work_days", List.of(Calendar.SUNDAY, Calendar.MONDAY, Calendar.TUESDAY, Calendar.WEDNESDAY, Calendar.THURSDAY));
        map.put("sampling_interval_seconds", 120L);
        return map;
    }

    @Test
    public void testValidParsingContinuous() {
        LocationPolicy policy = LocationPolicy.parse(validDoc(1L, true, "continuous"), 0L);
        assertEquals(1L, policy.revision);
        assertTrue(policy.enabled);
        assertEquals("continuous", policy.mode);
        assertEquals(120, policy.samplingIntervalSeconds);
        assertTrue(policy.shouldCollectAt(System.currentTimeMillis()));
    }

    @Test
    public void testWorkHoursSchedule() {
        LocationPolicy policy = LocationPolicy.parse(validDoc(2L, true, "work_hours"), 1L);
        assertEquals("work_hours", policy.mode);

        // Construct calendar on Monday 10:00 (within work hours)
        Calendar cal = Calendar.getInstance();
        cal.set(Calendar.DAY_OF_WEEK, Calendar.MONDAY);
        cal.set(Calendar.HOUR_OF_DAY, 10);
        cal.set(Calendar.MINUTE, 0);
        assertTrue(policy.shouldCollectAt(cal.getTimeInMillis()));

        // Construct calendar on Monday 22:00 (outside work hours)
        cal.set(Calendar.HOUR_OF_DAY, 22);
        assertFalse(policy.shouldCollectAt(cal.getTimeInMillis()));

        // Construct calendar on Friday (not in work days)
        cal.set(Calendar.DAY_OF_WEEK, Calendar.FRIDAY);
        cal.set(Calendar.HOUR_OF_DAY, 10);
        assertFalse(policy.shouldCollectAt(cal.getTimeInMillis()));
    }

    @Test
    public void testIntervalBoundsClamping() {
        Map<String, Object> doc = validDoc(1L, true, "continuous");
        doc.put("sampling_interval_seconds", 5L); // below min (30)
        LocationPolicy policy = LocationPolicy.parse(doc, 0L);
        assertEquals(30, policy.samplingIntervalSeconds);

        doc.put("sampling_interval_seconds", 10000L); // above max (3600)
        policy = LocationPolicy.parse(doc, 0L);
        assertEquals(3600, policy.samplingIntervalSeconds);
    }

    @Test
    public void testRejectsStaleRevision() {
        assertThrows(IllegalArgumentException.class, () -> LocationPolicy.parse(validDoc(1L, true, "continuous"), 2L));
    }

    @Test
    public void testMidnightCrossingSchedule() {
        Map<String, Object> doc = validDoc(3L, true, "work_hours");
        doc.put("start_time", "21:00");
        doc.put("end_time", "05:00");
        doc.put("work_days", List.of(Calendar.MONDAY)); // Monday night shift
        LocationPolicy policy = LocationPolicy.parse(doc, 0L);

        // Monday 22:00 -> active (before midnight)
        Calendar cal = Calendar.getInstance();
        cal.set(Calendar.DAY_OF_WEEK, Calendar.MONDAY);
        cal.set(Calendar.HOUR_OF_DAY, 22);
        cal.set(Calendar.MINUTE, 0);
        assertTrue(policy.shouldCollectAt(cal.getTimeInMillis()));

        // Tuesday 03:00 -> active (after midnight, yesterday was Monday)
        cal.set(Calendar.DAY_OF_WEEK, Calendar.TUESDAY);
        cal.set(Calendar.HOUR_OF_DAY, 3);
        assertTrue(policy.shouldCollectAt(cal.getTimeInMillis()));

        // Tuesday 06:00 -> inactive (shift ended at 05:00)
        cal.set(Calendar.HOUR_OF_DAY, 6);
        assertFalse(policy.shouldCollectAt(cal.getTimeInMillis()));
    }
}
